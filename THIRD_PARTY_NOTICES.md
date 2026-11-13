# Third-party components

The MIT license covers original Messenger Hub code. Dependencies, provider bridges
and patch context retain their respective upstream licenses; no third-party
license is replaced by this repository's license.

- Telegram MCP: https://github.com/chigwell/telegram-mcp — Apache-2.0. Telegram
  patch files modify that distribution and include upstream context. They are
  marked as modifications; the original distribution is not bundled.
- GOWA: https://github.com/aldinokemal/go-whatsapp-web-multidevice — MIT.
  `bridges/gowa-9.1.0-reply-evidence.patch` modifies v9.1.0; install the separately
  obtained upstream distribution with its copyright and license intact.
- Telethon: MIT. Python requests: Apache-2.0. Install these separately for optional
  bridge/video functionality and retain their upstream notices.
- JavaScript dependencies are pinned in package-lock.json. Their license and
  copyright files remain in the installed npm packages. No node_modules is bundled.
- FFmpeg/ffprobe are external executables, not bundled. Their license depends on
  the selected build; consult that distribution before redistribution.

Changed patch files are maintained here as extensions, not upstream releases.
See licenses/Apache-2.0.txt for the Apache license applying to upstream patch
context. This inventory does not grant rights to provider accounts or content.
