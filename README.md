# SHYDLE

Standalone Wordle-style browser game built with static HTML, CSS, and JavaScript.

## Current behavior

- The game loads its runtime word database from `words.json`.
- `words.json` contains two uppercase five-letter word lists: `answers` and `guesses`.
- The game chooses the secret word at random from `answers`.
- Typed guesses are considered valid if they appear in either `answers` or `guesses`.
- Answer selection is random, but the game remembers previously played answers in a cookie and avoids repeats until the full answer pool has been used.
- Hints are free-letter hints only.
- Settings currently control only the number of guesses.

## Files

- `index.html`: page structure
- `styles.css`: game styling
- `script.js`: game logic
- `words.json`: runtime answer/guess database
- `words-answers.txt`: source word list used to build `words.json` answers
- `words-guesses.txt`: source word list used to build `words.json` guesses
- `scripts/browser-smoke-test.js`: browser smoke test
- `scripts/browser-comprehensive-test.js`: broader browser regression test

## Run locally

Serve the folder over HTTP. The game fetches `words.json`, so opening `index.html` directly from disk is not the intended path.

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

## Open the game

From the same computer:

```text
http://localhost:8000
```

From another computer on the same network:

```text
http://YOUR_COMPUTER_IP:8000
```

## Test

Run the browser smoke test with:

```bash
make test-browser-smoke
```

Run the broader browser regression suite with:

```bash
make test-browser-comprehensive
```

## Notes about LAN access

- `localhost` only works on the machine running the server.
- Binding to `0.0.0.0` allows other devices on your LAN to connect.
- Both computers must be on the same local network unless you set up routing, tunneling, or port forwarding.
- Your firewall may need to allow incoming connections to `python3`.
- The local Python server is only for development and smoke testing, not production deployment.

## Deployment

Deployment details live in `DEPLOY.MD`.
