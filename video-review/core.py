#!/usr/bin/env python3
"""Prepare local videos, resume one paid Palatine task, and extract evidence frames.

Media and provider receipts live outside the skill so symlinked Codex homes share
results. A pre-submit journal and OS lock prevent duplicate charges after crashes.
"""
import argparse
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.parse import quote, urlparse

ROOT = Path(__file__).resolve().parent
CONFIG = Path.home() / '.config/codex-video-review'
CACHE = Path(os.environ.get('VIDEO_REVIEW_CACHE', str(Path.home() / '.cache/codex-video-review')))


def save(file, value):
    """Replace receipts atomically and durably before any paid network mutation."""
    temp = file.with_suffix(file.suffix + '.tmp')
    with temp.open('w') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(file)
    fd = os.open(file.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def run(args):
    """Pass paths as argv, never shell code; show bounded local decoder errors."""
    result = subprocess.run(args, capture_output=True, text=True, timeout=300)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr[-1200:]}')
    return result.stdout


def settings():
    """Separate transcription settings from credentials and never source dotenv."""
    conf = json.loads((ROOT / 'references/defaults.json').read_text())
    local = Path(os.environ.get('VIDEO_REVIEW_SETTINGS_FILE', str(CONFIG / 'settings.json')))
    if local.exists():
        conf.update(json.loads(local.read_text()))
    return conf


def token():
    """Use an explicit environment override or the shared private credential file."""
    value = os.environ.get('PALATINE_API_KEY')
    file = Path(os.environ.get('PALATINE_ENV_FILE', str(CONFIG / 'palatine.env')))
    if not value and file.exists():
        for line in file.read_text().splitlines():
            match = re.fullmatch(r'\s*(?:export\s+)?PALATINE_API_KEY\s*=\s*(.*?)\s*', line)
            if match:
                value = match[1].strip('\"\'')
    if not value:
        raise RuntimeError('PALATINE_API_KEY missing; see references/configuration.md')
    return value


def identity(source, conf):
    """Hash content, not filenames; exclude secret rotation from cache identity."""
    digest = hashlib.sha256()
    with source.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    sha = digest.hexdigest()
    profile = {k: conf[k] for k in ('submit_url', 'status_url', 'model', 'fast_inference')}
    if conf.get('account_namespace'): profile['account_namespace'] = conf['account_namespace']
    key = hashlib.sha256((sha + json.dumps(profile, sort_keys=True)).encode()).hexdigest()
    directory = CACHE / key
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory, sha, profile


def probe(source):
    """Keep the original timeline: extraction never trims silence or speeds audio."""
    info = json.loads(run(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(source)]))
    duration = float(info['format']['duration'])
    if not math.isfinite(duration) or duration <= 0:
        raise RuntimeError('Video duration is invalid')
    videos = [s for s in info['streams'] if s['codec_type'] == 'video']
    if not videos:
        raise RuntimeError('Source has no video stream')
    # Container duration may include audio beyond the last video frame. Bound
    # visual seeks to the video stream and leave a tail margin for sparse fps.
    visual_duration = float(videos[0].get('duration') or duration)
    rate_parts = videos[0].get('avg_frame_rate', '0/1').split('/')
    fps = float(rate_parts[0]) / float(rate_parts[1]) if float(rate_parts[1]) else 0
    margin = max(0.1, 2 / fps) if fps > 0 else 1.0
    last_seek = max(0, min(duration, visual_duration) - margin)
    return {'timeline_alignment':'source_zero_padded','duration_seconds': duration, 'video_duration_seconds': visual_duration,
            'overview_last_seek_seconds': last_seek, 'width': videos[0]['width'], 'height': videos[0]['height'],
            'has_audio': any(s['codec_type'] == 'audio' for s in info['streams'])}


def prepare(source, directory, sha, profile):
    """Write reusable metadata and speech-oriented Opus without uploading anything."""
    existing = directory / 'source.json'
    meta = json.loads(existing.read_text()) if existing.exists() else probe(source)
    if meta.get('sha256', sha) != sha: raise RuntimeError('Cache source digest mismatch')
    meta.update(source=str(source), sha256=sha, profile=profile)
    save(directory / 'source.json', meta)
    audio = directory / 'audio.ogg'
    if meta['has_audio'] and not audio.exists():
        temp = directory / 'audio.partial.ogg'
        run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-copyts', '-start_at_zero', '-i', str(source), '-map', '0:a:0',
             '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '32k', str(temp)])
        temp.replace(audio)
    return meta


def srt_segments(text):
    """Reject plain prose masquerading as SRT; expose cue bounds for frame choice."""
    cues = []
    for block in re.split(r'\n\s*\n', text.replace('\r\n', '\n').strip()):
        match = re.search(r'(?m)^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})[^\n]*\n([\s\S]+)', block)
        if match:
            start, end = seconds(match[1]), seconds(match[2])
            if end < start:
                raise RuntimeError('SRT cue ends before its start')
            cues.append({'start': start, 'end': end, 'text': match[3].strip()})
        elif block.strip():
            raise RuntimeError('Malformed SRT block; no partial transcript accepted')
    if not cues:
        raise RuntimeError('Provider result contains no valid SRT cues; task receipt retained')
    return cues


def seconds(raw):
    """Accept seconds, MM:SS or HH:MM:SS, including SRT comma fractions."""
    raw = raw.strip().replace(',', '.')
    if not re.fullmatch(r'\d+(?:\.\d+)?|\d+:\d{2}(?:\.\d+)?|\d+:\d{2}:\d{2}(?:\.\d+)?', raw):
        raise ValueError(f'Invalid timestamp: {raw}')
    parts = [float(p) for p in raw.split(':')]
    if len(parts) > 1 and (parts[-1] >= 60 or (len(parts) == 3 and parts[-2] >= 60)):
        raise ValueError(f'Invalid timestamp: {raw}')
    value = sum(p * 60 ** i for i, p in enumerate(reversed(parts)))
    if not math.isfinite(value):
        raise ValueError('Timestamp must be finite')
    return value


def transcribe(directory, conf, wait):
    """Submit at most once. Unknown submission stays blocked; known IDs resume GETs.

    Redirects are disabled to keep bearer credentials on the configured host.
    Only read-only polling is retryable; failed paid tasks require owner review.
    """
    import requests
    if (directory / 'transcript.srt').exists():
        return 0
    key = token()
    for endpoint in ('submit_url', 'status_url'):
        url = urlparse(conf[endpoint])
        if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost')):
            raise RuntimeError('Palatine URLs require HTTPS (loopback allowed for tests)')
    headers = {'Authorization': f'Bearer {key}'}
    receipt = directory / 'task.json'
    task = json.loads(receipt.read_text()) if receipt.exists() else {}
    if task.get('state') in ('submitting', 'submission_unknown', 'failed'):
        raise RuntimeError(f"Task state={task['state']}; inspect {receipt}; do not resubmit")
    if not task.get('task_id'):
        audio = directory / 'audio.ogg'
        if not audio.exists():
            raise RuntimeError('Video has no audio; use frames for a visual-only review')
        task = {'state': 'submitting', 'created_at': time.time()}
        save(receipt, task)
        try:
            with audio.open('rb') as handle:
                response = requests.post(conf['submit_url'], headers=headers,
                    params={'model': conf['model'], 'fast_inference': str(conf['fast_inference']).lower()},
                    files={'file': ('audio.ogg', handle, 'audio/ogg')},
                    timeout=conf['submit_timeout_seconds'], allow_redirects=False)
            if not 200 <= response.status_code < 300:
                raise RuntimeError(f'Palatine submit HTTP {response.status_code}')
            task_id = response.json().get('task_id')
            if not isinstance(task_id, str) or not task_id:
                raise RuntimeError('Palatine submit returned no task_id')
            task.update(state='pending', task_id=task_id)
            save(receipt, task)
        except Exception as error:
            # Persist only our bounded HTTP diagnostics or the exception class;
            # external response bodies/URLs may contain sensitive data.
            reason = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            task.update(state='submission_unknown', error=reason)
            save(receipt, task)
            raise RuntimeError(f'Submission stopped ({reason}); receipt: {receipt}; no automatic retry') from None
    deadline = time.monotonic() + wait
    while True:
        print(f"Polling Palatine task {task['task_id']}", file=sys.stderr)
        try:
            response = requests.get(conf['status_url'].replace('{task_id}', quote(task['task_id'], safe='')),
                headers=headers, params={'response_format': 'srt'},
                timeout=conf['poll_timeout_seconds'], allow_redirects=False)
        except requests.RequestException:
            print('Status network failure; task ID retained', file=sys.stderr)
            return 11
        if not 200 <= response.status_code < 300:
            raise RuntimeError(f'Palatine status HTTP {response.status_code}; task ID retained')
        body = response.json()
        status = body.get('status') or body.get('task_status')
        if status == 'success':
            data = body.get('data')
            variants = [data, body.get('srt'), body.get('text')]
            if isinstance(data, dict):
                variants = [data.get('srt'), data.get('text')] + variants
            text = next((v.strip() for v in variants if isinstance(v, str) and v.strip()), '')
            cues = srt_segments(text)
            save(directory / 'segments.json', cues)
            temp = directory / 'transcript.srt.tmp'
            temp.write_text(text + '\n')
            temp.replace(directory / 'transcript.srt')
            task['state'] = 'complete'
            save(receipt, task)
            return 0
        if status in ('error', 'failed'):
            task.update(state='failed', provider_status=status)
            save(receipt, task)
            raise RuntimeError(f'Palatine task failed; receipt: {receipt}; no automatic retry')
        if status not in ('pending', 'scheduled', 'processing', 'running', 'in_progress'):
            raise RuntimeError('Unknown Palatine status; task ID retained')
        if time.monotonic() + conf['poll_interval_seconds'] > deadline:
            return 11
        time.sleep(conf['poll_interval_seconds'])


def frames(source, directory, meta, args):
    """Extract original-resolution PNGs, retaining timestamp/source provenance.

    Overview samples are a navigation aid, not proof of complete visual coverage.
    Dense samples around clicks must be selected by the agent after reading SRT.
    """
    duration = meta['duration_seconds']
    if args.timestamps:
        times = [seconds(t) for t in args.timestamps.split(',')]
    else:
        if args.count < 1 or args.count > 60:
            raise ValueError('--count must be between 1 and 60')
        times = [i * meta['overview_last_seek_seconds'] / max(1, args.count - 1) for i in range(args.count)]
    if not 1 <= len(times) <= 60 or any(t >= min(duration, meta['video_duration_seconds']) for t in times):
        raise ValueError('Provide 1-60 timestamps strictly inside the video duration')
    out = directory / 'frames'
    out.mkdir(exist_ok=True, mode=0o700)
    manifest_file = directory / 'frames.json'
    manifest = json.loads(manifest_file.read_text()) if manifest_file.exists() else {}
    selected = []
    crop = None
    if args.crop:
        if not re.fullmatch(r'\d+:\d+:\d+:\d+', args.crop):
            raise ValueError('--crop must be x:y:width:height')
        x, y, w, h = map(int, args.crop.split(':'))
        if w < 1 or h < 1 or x+w > meta['width'] or y+h > meta['height']:
            raise ValueError('Crop must fit the source video dimensions')
        crop = f'crop={w}:{h}:{x}:{y}'
    for t in sorted(set(times)):
        label = f'{t:013.3f}'
        file = out / f'{label}.png'
        if not file.exists():
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-ss', str(t), '-i', str(source),
                 '-map', '0:v:0', '-frames:v', '1', str(file)])
        if not file.exists() or file.stat().st_size == 0:
            raise RuntimeError(f'No frame decoded at {t}; choose an earlier timestamp')
        entry = {'seconds': t, 'path': str(file), 'source_sha256': meta['sha256']}
        if crop:
            cropped = out / f'{label}-crop-{args.crop.replace(":", "-")}.png'
            run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(file), '-vf', crop, '-frames:v', '1', str(cropped)])
            entry['crop_path'] = str(cropped)
        manifest[label] = entry
        selected.append(entry)
    save(manifest_file, manifest)
    return selected


def manifest(directory, sha):
    """Read atomic legacy-compatible artifacts without downloads or provider calls."""
    meta_file, task_file = directory/'source.json', directory/'task.json'
    meta = json.loads(meta_file.read_text()) if meta_file.exists() else {}
    if meta.get('sha256',sha) != sha: raise RuntimeError('Cache source digest mismatch')
    task = json.loads(task_file.read_text()) if task_file.exists() else {}
    ready = (directory/'transcript.srt').exists()
    segments_file = directory/'segments.json'
    # Legacy ready SRT can be read through without billing or modifying a receipt.
    segments = json.loads(segments_file.read_text()) if segments_file.exists() else srt_segments((directory/'transcript.srt').read_text()) if ready else []
    state = task.get('state')
    status = 'queued' if not meta and not task and not ready else 'ready' if ready or meta.get('has_audio') is False else 'submission_unknown' if state in ('submitting','submission_unknown') else 'failed' if state=='failed' else 'transcribing'
    return {'status':status,'sha256':sha,'cache':str(directory),
            'durationSeconds':meta.get('duration_seconds'),'hasAudio':meta.get('has_audio'),
            'width':meta.get('width'),'height':meta.get('height'),'segmentCount':len(segments),'timelineAlignment':meta.get('timeline_alignment','legacy_unverified'),
            'progress':{'phase':status},'taskKnown':bool(task.get('task_id')),
            **({'error':{'code':'video_submission_unknown' if status=='submission_unknown' else 'video_provider_failed','retryable':False}} if status in ('failed','submission_unknown') else {})}


def hub_action(payload):
    """Headless local adapter. Hub authorizes paths before invoking this process.

    All mutations share the exact CLI OS lock/cache identity. Read actions never
    POST/GET or run ffmpeg. Saved settings snapshots keep pending tasks on their
    original profile across restart or later configuration changes.
    """
    action = payload['action']
    conf = payload.get('settings') or settings()
    if action=='settings': return conf
    source = Path(payload['source']).resolve(strict=True)
    directory, sha, profile = identity(source,conf)
    if action=='status':
        result=manifest(directory,sha)
        receipt=directory/'task.json'
        task=json.loads(receipt.read_text()) if receipt.exists() else {}
        # A live upload owns the shared OS lock and has intentionally persisted
        # submitting before POST. It is still running, not a crash/unknown yet.
        # A stale submitting receipt without that lock remains fenced unknown.
        if task.get('state')=='submitting':
            with (directory/'.lock').open('a') as lock:
                try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:
                    result.pop('error',None)
                    result.update(status='transcribing',progress={'phase':'submitting'},submissionInProgress=True)
        return result
    if action=='read':
        result=manifest(directory,sha)
        if result['status']!='ready': raise RuntimeError('video_not_ready')
        file=directory/'segments.json'
        cues=json.loads(file.read_text()) if file.exists() else srt_segments((directory/'transcript.srt').read_text()) if (directory/'transcript.srt').exists() else []
        offset, limit=payload.get('offset',0),payload.get('limit',100)
        if not isinstance(offset,int) or offset<0 or not isinstance(limit,int) or not 1<=limit<=100: raise ValueError('video_page_invalid')
        return {'segments':cues[offset:offset+limit],'offset':offset,'nextOffset':offset+limit if offset+limit<len(cues) else None,'total':len(cues),'durationSeconds':result['durationSeconds'],'sha256':sha,'timelineAlignment':result['timelineAlignment']}
    with (directory/'.lock').open('a') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: return {**manifest(directory,sha),'lockBusy':True}
        if action=='prepare':
            state=manifest(directory,sha)
            if state['status'] in ('ready','failed','submission_unknown'): return state
            meta=prepare(source,directory,sha,profile)
            if meta['has_audio']:
                try: transcribe(directory,conf,0)
                except (RuntimeError,ValueError,OSError):
                    state=manifest(directory,sha)
                    if state['status'] in ('failed','submission_unknown'): return state
                    # A known provider ID is retained even for invalid SRT/read errors.
                    if state['taskKnown']: return {**state,'error':{'code':'video_status_unavailable','retryable':True}}
                    raise
            return manifest(directory,sha)
        if action=='frames':
            meta=probe(source);meta['sha256']=sha
            times=payload['timestamps']
            if not 1<=len(times)<=12 or any(not isinstance(t,(int,float)) or not math.isfinite(t) or t<0 for t in times): raise ValueError('video_timestamps_invalid')
            args=argparse.Namespace(timestamps=','.join(str(t) for t in times),count=0,crop=None)
            c=payload.get('crop')
            if c: args.crop=':'.join(str(c[k]) for k in ('x','y','width','height'))
            selected=frames(source,directory,meta,args)
            result=[]
            for f in selected:
                file=Path(f.get('crop_path') or f['path'])
                result.append({'path':str(file),'sha256':hashlib.sha256(file.read_bytes()).hexdigest(),
                               'seconds':f['seconds'],'width':c['width'] if c else meta['width'],
                               'height':c['height'] if c else meta['height'],
                               'precision':'requested_seek_source_frame_quantized',**({'crop':c} if c else {})})
            return {'sha256':sha,'durationSeconds':meta['duration_seconds'],'frames':result}
        raise ValueError('video_action_invalid')


def main():
    """One lock covers both homes and every mutation; kernel releases it on death."""
    os.umask(0o077)
    if len(sys.argv)>1 and sys.argv[1]=='hub':
        try: print(json.dumps(hub_action(json.load(sys.stdin)),ensure_ascii=False));return 0
        except Exception as error:
            # Hub diagnostics never include filesystem paths, tokens or raw provider bodies.
            code = 'video_not_ready' if str(error)=='video_not_ready' else 'video_input_invalid' if isinstance(error,ValueError) else 'video_core_failed'
            print(json.dumps({'error':code}));return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'lookup', 'transcribe', 'frames'])
    parser.add_argument('--file', required=True, type=Path)
    parser.add_argument('--wait', type=float, default=40, help='Polling budget in seconds; pending exits 11')
    parser.add_argument('--timestamps', help='Comma-separated seconds or HH:MM:SS.mmm')
    parser.add_argument('--count', type=int, default=8, help='Evenly spaced overview frames if no timestamps')
    parser.add_argument('--crop', help='Optional x:y:width:height crop; full frames are retained')
    args = parser.parse_args()
    if not math.isfinite(args.wait) or args.wait < 0:
        parser.error('--wait must be a finite nonnegative number')
    conf = settings()
    source = args.file.expanduser().resolve(strict=True)
    directory, sha, profile = identity(source, conf)
    with (directory / '.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another process is preparing this video; rerun after it completes', file=sys.stderr)
            return 12
        if args.command == 'lookup':
            result = {'cache': str(directory), 'ready': (directory / 'transcript.srt').exists()}
            if (directory / 'task.json').exists():
                result['task'] = json.loads((directory / 'task.json').read_text())
            print(json.dumps(result, indent=2))
            return 0 if result['ready'] else 10
        # Frame-only operation must also work for silent videos without audio extraction.
        meta = probe(source) if args.command == 'frames' else prepare(source, directory, sha, profile)
        meta['sha256'] = sha
        code = 0
        result = {'cache': str(directory), 'metadata': meta}
        if args.command == 'transcribe':
            code = transcribe(directory, conf, args.wait) if meta['has_audio'] else 0
            result.update(ready=code == 0, transcript=str(directory / 'transcript.srt'), segments=str(directory / 'segments.json'))
        elif args.command == 'frames':
            result['frames'] = frames(source, directory, meta, args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, OSError, KeyError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
