"""
GP Importer plugin — bulk-import Guitar Pro files as playable feedpaks with audio.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import zipfile
from pathlib import Path

import yaml
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


_GP_EXTS = ('.gp3', '.gp4', '.gp5', '.gp', '.gpx')

_progress_lock = threading.Lock()
_progress = {
    "running": False,
    "total": 0,
    "done": 0,
    "current_file": "",
    "message": "",
    "results": [],
}


def _update_progress(**kw):
    with _progress_lock:
        _progress.update(kw)


def _safe_name(name: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]', '', name).strip()
    return safe or "Unknown"


def _arr_id(name: str) -> str:
    aid = re.sub(r'[^a-z0-9]', '', name.lower())[:16]
    return aid or "arr"


def _fluidsynth_available() -> bool:
    return shutil.which("fluidsynth") is not None


def _soundfont_path() -> str | None:
    try:
        from gp2midi import _find_soundfont
        return _find_soundfont()
    except Exception:
        return None


def _has_fluidsynth_deps() -> bool:
    return _fluidsynth_available() and _soundfont_path() is not None


def _guitarpro_available() -> bool:
    try:
        import guitarpro
        return True
    except ImportError:
        return False


def setup(app, context):
    log = context["log"]
    router = APIRouter(prefix="/api/plugins/gp_importer")

    def _dlc_root() -> Path | None:
        try:
            dlc = context["get_dlc_dir"]()
            return Path(dlc) if dlc else None
        except Exception:
            return None

    @router.get("/deps")
    def check_deps():
        sfp = _soundfont_path()
        return JSONResponse({
            "guitarpro": _guitarpro_available(),
            "fluidsynth": _fluidsynth_available(),
            "soundfont": sfp is not None,
            "soundfont_path": sfp,
            "dlc_configured": _dlc_root() is not None,
        })

    @router.post("/scan")
    async def scan_dir(request: Request):
        body = await request.json()
        directory = (body.get("directory") or "").strip()
        if not directory:
            return JSONResponse({"error": "No directory specified"}, status_code=400)

        scan_path = Path(directory).expanduser().resolve()
        if not scan_path.is_dir():
            return JSONResponse(
                {"error": f"Directory not found: {directory}"},
                status_code=400,
            )

        files = []
        for ext in _GP_EXTS:
            for f in sorted(scan_path.rglob(f"*{ext}")):
                if f.name.startswith("."):
                    continue
                files.append(f)

        if not files:
            return JSONResponse({
                "files": [],
                "directory": str(scan_path),
                "total": 0,
            })

        dlc = _dlc_root()
        result_files = []
        import guitarpro as gp_module
        from gp2rs import auto_select_tracks

        for f in files:
            try:
                song = gp_module.parse(str(f))
                sel_indices, sel_names = auto_select_tracks(str(f))

                tracks = []
                for i, t in enumerate(song.tracks):
                    inst = ""
                    try:
                        inst = str(t.channel.instrument) if t.channel else ""
                    except Exception:
                        pass
                    tracks.append({
                        "index": i,
                        "name": t.name,
                        "instrument": inst,
                        "selected": i in sel_indices,
                        "assigned_name": sel_names.get(i, t.name),
                    })

                duration = 0.0
                try:
                    if song.measureHeaders:
                        last_mh = song.measureHeaders[-1]
                        total_ticks = last_mh.start
                        tempo_bpm = max(song.tempo, 1)
                        duration = (total_ticks / 960.0) * (60.0 / tempo_bpm)
                except Exception:
                    pass

                already = False
                if dlc:
                    safe_artist = _safe_name(getattr(song, 'artist', '') or '')
                    safe_title = _safe_name(song.title or f.stem)
                    feed_name = f"{safe_artist} - {safe_title}.feedpak" if safe_artist else f"{safe_title}.feedpak"
                    if (dlc / feed_name).exists():
                        already = True
                    sloppak_dir = dlc / "sloppak"
                    if sloppak_dir.is_dir() and (sloppak_dir / feed_name).exists():
                        already = True

                result_files.append({
                    "path": str(f),
                    "title": song.title or f.stem,
                    "artist": getattr(song, 'artist', '') or '',
                    "album": getattr(song, 'album', '') or '',
                    "duration": duration,
                    "tracks": tracks,
                    "track_count": len(song.tracks),
                    "selected_tracks": sum(1 for t in tracks if t["selected"]),
                    "already_imported": already,
                })
            except Exception as e:
                log.warning("Failed to parse %s: %s", f.name, e)
                result_files.append({
                    "path": str(f),
                    "title": f.stem,
                    "artist": "",
                    "album": "",
                    "duration": 0,
                    "tracks": [],
                    "track_count": 0,
                    "selected_tracks": 0,
                    "already_imported": False,
                    "parse_error": str(e),
                })

        return JSONResponse({
            "files": result_files,
            "directory": str(scan_path),
            "total": len(result_files),
        })

    @router.post("/import")
    async def start_import(request: Request):
        body = await request.json()
        file_paths = body.get("files", [])
        if not file_paths:
            return JSONResponse({"error": "No files specified"}, status_code=400)

        if not _has_fluidsynth_deps():
            return JSONResponse({
                "error": "FluidSynth or soundfont not available. Check /deps."
            }, status_code=400)

        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({
                "error": "DLC directory not configured."
            }, status_code=400)

        with _progress_lock:
            if _progress["running"]:
                return JSONResponse(
                    {"error": "Import already in progress"}, status_code=409
                )
            _progress["running"] = True
            _progress["total"] = len(file_paths)
            _progress["done"] = 0
            _progress["current_file"] = ""
            _progress["message"] = "Starting..."
            _progress["results"] = []

        def _worker():
            try:
                _run_import(file_paths, log, dlc)
            except Exception as e:
                log.exception("Import worker crashed")
                _update_progress(running=False, message=f"Import failed: {e}")

        threading.Thread(target=_worker, daemon=True).start()
        return JSONResponse({"ok": True, "total": len(file_paths)})

    @router.get("/status")
    def get_status():
        with _progress_lock:
            return JSONResponse(dict(_progress))

    app.include_router(router)
    log.info("gp_importer routes registered")


def _run_import(file_paths: list[str], log, dlc_dir: Path):
    from gp2rs import convert_file
    from gp2midi import gp_to_audio
    from song import parse_arrangement, arrangement_to_wire
    import guitarpro as gp_module
    import xml.etree.ElementTree as ET

    results = []
    output_dir = dlc_dir / "sloppak" if (dlc_dir / "sloppak").is_dir() else dlc_dir

    for i, gp_path_str in enumerate(file_paths):
        gp_path = Path(gp_path_str)
        _update_progress(
            current_file=gp_path.name,
            message="Parsing...",
            done=i,
        )

        result = {
            "file": gp_path_str,
            "title": gp_path.stem,
            "success": False,
            "error": None,
        }
        tmpdir = None

        try:
            gp_song = gp_module.parse(str(gp_path))
            result["title"] = gp_song.title or gp_path.stem
            result["artist"] = getattr(gp_song, 'artist', '') or ''
            result["album"] = getattr(gp_song, 'album', '') or ''
            year = getattr(gp_song, 'year', None)
            if year is not None:
                try:
                    result["year"] = int(year)
                except (ValueError, TypeError):
                    pass

            tmpdir = tempfile.mkdtemp(prefix="gp_import_")

            _update_progress(message="Converting arrangements...")
            xmls = convert_file(
                str(gp_path), tmpdir,
                expand_repeats=False,
            )
            if not xmls:
                raise RuntimeError("No playable arrangements produced")

            arrangements_data = []
            for xf in xmls:
                arr = parse_arrangement(xf)
                arrangements_data.append(arrangement_to_wire(arr))

            first_xml = xmls[0]
            tree = ET.parse(first_xml)
            root = tree.getroot()

            song_length = None
            el = root.find("songLength")
            if el is not None and el.text:
                song_length = float(el.text)

            beats = []
            container = root.find("ebeats")
            if container is not None:
                for eb in container.findall("ebeat"):
                    t = float(eb.get("time", "0"))
                    m = int(eb.get("measure", "-1"))
                    beats.append({"time": round(t, 3), "measure": m})

            sections = []
            container = root.find("sections")
            if container is not None:
                for s in container.findall("section"):
                    sections.append({
                        "name": s.get("name", ""),
                        "number": int(s.get("number", "1")),
                        "time": float(s.get("startTime", "0")),
                    })

            _update_progress(message="Rendering audio (FluidSynth)...")
            audio_staging = os.path.join(tmpdir, "audio")
            audio_path = gp_to_audio(str(gp_path), audio_staging)

            _update_progress(message="Building feedpak...")
            staging = Path(tempfile.mkdtemp(prefix="feedpak_"))
            try:
                arr_dir = staging / "arrangements"
                stems_dir = staging / "stems"
                arr_dir.mkdir()
                stems_dir.mkdir()

                shutil.copy2(audio_path, stems_dir / "full.ogg")

                used_ids = set()
                manifest_arrs = []
                for idx, wd in enumerate(arrangements_data):
                    name = wd.get("name", f"Arrangement {idx}")
                    aid = _arr_id(name)
                    if not aid or aid in used_ids:
                        j = 2
                        candidate = aid or "arr"
                        while f"{candidate}{j}" in used_ids:
                            j += 1
                        aid = f"{candidate}{j}"
                    used_ids.add(aid)

                    if idx == 0:
                        wd["beats"] = beats
                        wd["sections"] = sections

                    (arr_dir / f"{aid}.json").write_text(
                        json.dumps(wd, separators=(",", ":")),
                        encoding="utf-8",
                    )

                    manifest_arrs.append({
                        "id": aid,
                        "name": name,
                        "file": f"arrangements/{aid}.json",
                        "tuning": wd.get("tuning", [0] * 6),
                        "capo": int(wd.get("capo", 0)),
                    })

                manifest = {
                    "title": result["title"],
                    "artist": result.get("artist", ""),
                    "album": result.get("album", ""),
                    "duration": round(song_length or 0.0, 3),
                    "stems": [{"id": "full", "file": "stems/full.ogg"}],
                    "arrangements": manifest_arrs,
                }
                if result.get("year"):
                    manifest["year"] = result["year"]

                (staging / "manifest.yaml").write_text(
                    yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
                    encoding="utf-8",
                )

                safe_artist = _safe_name(result.get("artist", ""))
                safe_title = _safe_name(result["title"])
                feed_name = (
                    f"{safe_artist} - {safe_title}.feedpak"
                    if safe_artist
                    else f"{safe_title}.feedpak"
                )
                feed_path = output_dir / feed_name

                with zipfile.ZipFile(str(feed_path), "w", zipfile.ZIP_DEFLATED) as zf:
                    for f in staging.rglob("*"):
                        if f.is_file():
                            zf.write(f, f.relative_to(staging).as_posix())

                result["success"] = True
                result["feedpak"] = str(feed_path)
                log.info("Imported %s → %s (%d arr)",
                         gp_path.name, feed_path.name, len(arrangements_data))
            finally:
                shutil.rmtree(staging, ignore_errors=True)

        except subprocess.CalledProcessError as e:
            msg = e.stderr[-500:] if e.stderr else str(e)
            result["error"] = f"Audio render failed: {msg}"
            log.warning("Import audio failed for %s: %s", gp_path.name, msg)
        except RuntimeError as e:
            result["error"] = str(e)
            log.warning("Import failed for %s: %s", gp_path.name, e)
        except Exception as e:
            result["error"] = str(e)
            log.warning("Import failed for %s: %s", gp_path.name, e)
            import traceback
            log.debug(traceback.format_exc())
        finally:
            if tmpdir:
                shutil.rmtree(tmpdir, ignore_errors=True)

        results.append(result)
        _update_progress(done=i + 1, results=list(results))

    _update_progress(
        running=False,
        message="Import complete",
        current_file="",
        results=list(results),
    )
    log.info("GP import batch done: %d/%d succeeded",
             sum(1 for r in results if r["success"]), len(results))
