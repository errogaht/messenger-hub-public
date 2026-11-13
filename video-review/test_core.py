#!/usr/bin/env python3
"""Behavioral checks for billing safety and timestamped evidence, without paid IO."""
import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import requests
import core as vr

SRT = '1\n00:00:01,200 --> 00:00:03,400\nClick the Save button.\n'


class Response:
    """Minimal provider envelope; tests exercise the real transcription state flow."""
    status_code = 200

    def __init__(self, body):
        self.body = body

    def json(self):
        return self.body


class ProviderScenarios(unittest.TestCase):
    def setUp(self):
        """Isolate receipts from the real shared cache and use an unprivileged token."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        (self.directory / 'audio.ogg').write_bytes(b'test audio')
        self.conf = vr.settings()
        self.conf['poll_interval_seconds'] = 0.001
        self.key = patch.object(vr, 'token', return_value='dummy-test-token')
        self.key.start()
        self.addCleanup(self.key.stop)

    def test_pending_resumes_original_task_and_cache_skips_network(self):
        # The first poll is pending; a second invocation must GET the same ID,
        # and a third invocation must use the completed SRT without any request.
        def submit(*args, **kwargs):
            self.assertEqual(json.loads((self.directory/'task.json').read_text())['state'], 'submitting')
            return Response({'task_id': 'test-task'})
        with patch('requests.post', side_effect=submit) as post, patch('requests.get', side_effect=[
                Response({'status':'pending'}), Response({'status':'success','data':SRT})]) as get:
            self.assertEqual(vr.transcribe(self.directory, self.conf, 0), 11)
            self.assertEqual(vr.transcribe(self.directory, self.conf, 0), 0)
            self.assertEqual(vr.transcribe(self.directory, self.conf, 0), 0)
            self.assertEqual(post.call_count, 1)
            self.assertEqual(get.call_count, 2)
        self.assertEqual(json.loads((self.directory/'segments.json').read_text())[0]['start'], 1.2)

    def test_ambiguous_submit_is_never_retried(self):
        # A timeout could follow provider acceptance; preserve the blocker across
        # subsequent invocations even though no task ID was received locally.
        with patch('requests.post', side_effect=requests.Timeout) as post:
            for _ in range(2):
                with self.assertRaises(RuntimeError):
                    vr.transcribe(self.directory, self.conf, 0)
            self.assertEqual(post.call_count, 1)
        self.assertEqual(json.loads((self.directory/'task.json').read_text())['state'], 'submission_unknown')

    def test_crashed_pre_submit_journal_stops_new_upload(self):
        # SIGKILL after the pre-submit journal is indistinguishable from a lost
        # reply; releasing the OS lock must not itself authorize another POST.
        vr.save(self.directory/'task.json', {'state':'submitting'})
        with patch('requests.post') as post, self.assertRaises(RuntimeError):
            vr.transcribe(self.directory, self.conf, 0)
        post.assert_not_called()

    def test_provider_failure_is_durable(self):
        # A terminal paid task stays failed rather than silently charging again.
        vr.save(self.directory/'task.json', {'state':'pending','task_id':'failed-task'})
        with patch('requests.post') as post, patch('requests.get', return_value=Response({'status':'error'})) as get:
            for _ in range(2):
                with self.assertRaises(RuntimeError):
                    vr.transcribe(self.directory, self.conf, 0)
        post.assert_not_called()
        self.assertEqual(get.call_count, 1)

    def test_plain_text_cannot_be_mistaken_for_timecoded_success(self):
        # Keep the known ID for diagnosis when a provider returns prose instead
        # of SRT. A successful HTTP envelope is insufficient evidence.
        vr.save(self.directory/'task.json', {'state':'pending','task_id':'bad-srt'})
        with patch('requests.get', return_value=Response({'status':'success','data':'no timecodes'})):
            with self.assertRaises(RuntimeError):
                vr.transcribe(self.directory, self.conf, 0)
        self.assertFalse((self.directory/'transcript.srt').exists())
        self.assertEqual(json.loads((self.directory/'task.json').read_text())['task_id'], 'bad-srt')

    def test_status_timeout_only_resumes_get(self):
        # Read-only network failure preserves the pending task for later polling.
        vr.save(self.directory/'task.json', {'state':'pending','task_id':'existing'})
        with patch('requests.post') as post, patch('requests.get', side_effect=requests.Timeout):
            self.assertEqual(vr.transcribe(self.directory, self.conf, 0), 11)
        post.assert_not_called()

    def test_renamed_copy_keeps_identity_but_model_change_does_not(self):
        # Source filenames and CODEX_HOME are irrelevant; transcription profile
        # changes intentionally isolate results while key rotation does not.
        a, b = self.directory/'a.mp4', self.directory/'b.mp4'
        a.write_bytes(b'identical video')
        b.write_bytes(a.read_bytes())
        with patch.object(vr, 'CACHE', self.directory/'cache'):
            original = vr.identity(a, self.conf)[0]
            self.assertEqual(original, vr.identity(b, self.conf)[0])
            changed = dict(self.conf, model='another-model')
            self.assertNotEqual(original, vr.identity(b, changed)[0])

    def test_http_failure_records_safe_diagnostic(self):
        # Preserve the exact HTTP status without persisting raw response bodies
        # or allowing a subsequent invocation to repeat the paid submission.
        reply = Response({})
        reply.status_code = 401
        with patch('requests.post', return_value=reply) as post:
            with self.assertRaisesRegex(RuntimeError, 'HTTP 401'):
                vr.transcribe(self.directory, self.conf, 0)
            with self.assertRaises(RuntimeError):
                vr.transcribe(self.directory, self.conf, 0)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(json.loads((self.directory/'task.json').read_text())['error'], 'Palatine submit HTTP 401')

    def test_overview_uses_video_end_when_audio_is_longer(self):
        # A container may outlive the video stream; overview seeks must remain
        # before the final decodable picture instead of following the audio tail.
        probe_json = {'format': {'duration': '12.0'}, 'streams': [
            {'codec_type': 'video', 'duration': '10.0', 'width': 1280,
             'height': 720, 'avg_frame_rate': '25/1'}, {'codec_type': 'audio'}]}
        with patch.object(vr, 'run', return_value=json.dumps(probe_json)):
            meta = vr.probe(Path('test.mp4'))
        self.assertEqual(meta['duration_seconds'], 12.0)
        self.assertEqual(meta['video_duration_seconds'], 10.0)
        self.assertAlmostEqual(meta['overview_last_seek_seconds'], 9.9)

    def test_timestamp_and_crop_boundaries(self):
        # Timestamp conversion must preserve subsecond cue positions and reject
        # values that could become decoder options or out-of-range seeks.
        self.assertEqual(vr.seconds('01:02:03.250'), 3723.25)
        self.assertEqual(vr.seconds('00:03,125'), 3.125)
        for raw in ('-ss', '00:60', 'nan', '-1'):
            with self.assertRaises(ValueError):
                vr.seconds(raw)
        self.assertEqual(vr.srt_segments(SRT)[0]['end'], 3.4)




class SharedCoreIntegration(unittest.TestCase):
    """Real cross-process lock/CLI contracts with a fake loopback paid provider."""
    def test_cli_and_hub_concurrent_share_one_post_and_existing_receipt(self):
        import http.server
        import threading
        import subprocess
        import os
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);source=root/'clip.mp4';cache=root/'cache'
            subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=blue:size=32x24:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','1','-c:v','mpeg4','-c:a','aac','-y',str(source)],check=True)
            counts={'post':0,'get':0}
            class Provider(http.server.BaseHTTPRequestHandler):
                def log_message(self,*args): pass
                def do_POST(self):
                    # A real multipart request reaches only this synthetic server.
                    counts['post']+=1;self.rfile.read(int(self.headers['Content-Length']))
                    import time;time.sleep(.2)
                    data=json.dumps({'task_id':'synthetic-task'}).encode();self.send_response(200);self.end_headers();self.wfile.write(data)
                def do_GET(self):
                    counts['get']+=1;data=json.dumps({'status':'success','data':SRT}).encode();self.send_response(200);self.end_headers();self.wfile.write(data)
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Provider)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            try:
                conf=vr.settings();base=f'http://127.0.0.1:{server.server_port}'
                conf.update(submit_url=base+'/submit',status_url=base+'/status/{task_id}')
                settings=root/'settings.json';settings.write_text(json.dumps(conf))
                env={**os.environ,'PALATINE_API_KEY':'synthetic-key','VIDEO_REVIEW_SETTINGS_FILE':str(settings),'VIDEO_REVIEW_CACHE':str(cache)}
                core=str(Path(vr.__file__))
                cli=subprocess.Popen([sys.executable,core,'transcribe','--file',str(source),'--wait','0'],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                hub=subprocess.Popen([sys.executable,core,'hub'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                out,_=hub.communicate(json.dumps({'action':'prepare','source':str(source)}).encode(),timeout=20)
                cli.communicate(timeout=20)
                # Whichever process held the common lock owns the single submission.
                result=subprocess.run([sys.executable,core,'hub'],input=json.dumps({'action':'prepare','source':str(source)}),env=env,text=True,capture_output=True,check=True)
                self.assertEqual(json.loads(result.stdout)['status'],'ready');self.assertEqual(counts['post'],1)
                env['PALATINE_API_KEY']='rotated-synthetic-key'
                result=subprocess.run([sys.executable,core,'hub'],input=json.dumps({'action':'status','source':str(source)}),env=env,text=True,capture_output=True,check=True)
                self.assertEqual(json.loads(result.stdout)['status'],'ready');self.assertEqual(counts['post'],1)
            finally: server.shutdown();server.server_close()

    def test_unknown_and_known_pending_receipts_survive_headless_restart(self):
        # Import/read-through preserves an ambiguous task; no invocation can POST again.
        with tempfile.TemporaryDirectory() as root,patch.object(vr,'CACHE',Path(root)):
            source=Path(root)/'source.mp4';source.write_bytes(b'synthetic source')
            conf=vr.settings();directory,sha,profile=vr.identity(source,conf)
            vr.save(directory/'source.json',{'sha256':sha,'profile':profile,'has_audio':True,'duration_seconds':4})
            vr.save(directory/'task.json',{'state':'submission_unknown'})
            with patch('requests.post') as post:
                self.assertEqual(vr.hub_action({'action':'prepare','source':str(source),'settings':conf})['status'],'submission_unknown');post.assert_not_called()
            # A known paid ID can resume GET only after process restart.
            (directory/'audio.ogg').write_bytes(b'audio');vr.save(directory/'task.json',{'state':'pending','task_id':'existing'})
            with patch.object(vr,'token',return_value='synthetic'),patch('requests.post') as post,patch('requests.get',return_value=Response({'status':'success','data':SRT})) as get:
                self.assertEqual(vr.hub_action({'action':'prepare','source':str(source),'settings':conf})['status'],'ready');post.assert_not_called();self.assertEqual(get.call_count,1)
            with patch('requests.get') as get:
                page=vr.hub_action({'action':'read','source':str(source),'settings':conf,'offset':0,'limit':1});self.assertEqual(page['segments'][0]['start'],1.2);get.assert_not_called()

class SubmittingStatus(unittest.TestCase):
    def test_live_lock_is_running_but_stale_submission_is_unknown(self):
        """A status read during POST cannot tell the caller to abandon a live job."""
        import fcntl
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);source=root/'source.bin';source.write_bytes(b'synthetic')
            conf=json.loads((vr.ROOT/'references/defaults.json').read_text())
            with patch.object(vr,'CACHE',root/'cache'):
                directory,sha,_=vr.identity(source,conf)
                vr.save(directory/'source.json',{'sha256':sha,'has_audio':True})
                vr.save(directory/'task.json',{'state':'submitting'})
                with (directory/'.lock').open('a') as lock:
                    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                    active=vr.hub_action({'action':'status','source':str(source),'settings':conf})
                    self.assertEqual(active['status'],'transcribing')
                    self.assertNotIn('error',active)
                stale=vr.hub_action({'action':'status','source':str(source),'settings':conf})
                self.assertEqual(stale['status'],'submission_unknown')
                self.assertFalse(stale['error']['retryable'])


if __name__ == '__main__':
    unittest.main()
