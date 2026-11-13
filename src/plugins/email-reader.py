"""Parse an explicitly selected local RFC822 export; no network/login/ASR path."""
import base64
import hashlib
import json
import os
import sys
from email import policy
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from pathlib import Path

filename = Path(sys.argv[1])
with os.fdopen(os.open(filename, os.O_RDONLY | os.O_NOFOLLOW), "rb") as handle:
    raw = handle.read(25 * 1024 * 1024 + 1)
if len(raw) > 25 * 1024 * 1024:
    raise ValueError('email_size_limit')
mail = BytesParser(policy=policy.default).parsebytes(raw)
parts = list(mail.walk())
attachments = [(i, p) for i, p in enumerate(parts) if p.get_filename() or p.get_content_disposition() == 'attachment']
if len(sys.argv) > 2:
    index = int(sys.argv[2])
    part = next(p for i, p in attachments if i == index)
    print(json.dumps({'base64': base64.b64encode(part.get_payload(decode=True) or b'').decode(),
                      'filename': part.get_filename(), 'mimeType': part.get_content_type()}))
else:
    body = mail.get_body(preferencelist=('plain', 'html'))
    text = body.get_content() if body else ''
    try:
        at = parsedate_to_datetime(str(mail['Date']))
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
    except Exception:
        at = datetime.fromtimestamp(filename.stat().st_mtime, timezone.utc)
    print(json.dumps({'at': at.isoformat(), 'text': text,
      'email': {'subject': str(mail.get('Subject', '')), 'from': str(mail.get('From', '')),
                'to': str(mail.get('To', '')), 'messageId': str(mail.get('Message-ID', '')),
                'bodyFormat': 'html_source' if body and body.get_content_type() == 'text/html' else 'plain'},
      'attachments': [{'id': 'part:' + str(i) + ':' + hashlib.sha256(raw).hexdigest(), 'kind': 'audio' if p.get_content_type().startswith('audio/') else 'image' if p.get_content_type().startswith('image/') else 'video' if p.get_content_type().startswith('video/') else 'document',
                      'filename': p.get_filename(), 'mimeType': p.get_content_type(),
                      'size': len(p.get_payload(decode=True) or b'')} for i, p in attachments]}, ensure_ascii=False))
