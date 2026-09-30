# Recording the demos

These scripts made `docs/demo-web.gif` / `docs/demo-web.mp4`. They need Playwright, ffmpeg and gifski,
which are not project dependencies:

```bash
npm i --no-save playwright && npx playwright install chromium
brew install ffmpeg gifski
```

1. Start a battler server just for the recording, with its own battles folder:
   `battler serve --no-open --port 4852 -o /tmp/demo-battles`
2. Record a real battle (takes 2-3 minutes; about 9 calls on your plans):
   `node scripts/demo/record-web.mjs 4852 video-real`
3. Optionally record a calmer tour of the finished verdict from its saved page (no new battle):
   `node scripts/demo/record-saved.mjs 4852 <battle id> video-saved`
4. Speed up the waiting and export MP4 + GIF: `sh scripts/demo/edit.sh video-real demo-web 12`

The terminal GIF (`docs/demo-terminal.gif`) was recorded with asciinema and rendered with agg.

To rehearse without using your plans, run the server against the fake CLIs:
`PATH=$PWD/test/fixtures/bin:$PATH FAKE_DELAY_MS=3000 FAKE_RICH=1 battler serve --no-open --port 4851`
