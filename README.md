# Wordle

Standalone Wordle-style browser game built with static HTML, CSS, and JavaScript.

## Current behavior

- The game loads its runtime word database from `words.json`.
- Each entry in `words.json` contains a five-letter word and its hint definition.
- Guesses are validated only against the words loaded from `words.json`.
- Clicking `Start New Game` reloads `words.json` with a cache-busting query string before choosing the next answer.
- Answer selection is random, but the game remembers previously played answers in a cookie and avoids repeats until the full local pool has been used.
- Hints come from the definition stored in `words.json`.

## Files

- `index.html`: page structure
- `styles.css`: game styling
- `script.js`: game logic
- `words.json`: runtime word database and hint source
- `scripts/build_fallback_words.py`: local builder for `words.json`
- `start-server.sh`: helper script to launch a local Python web server
- `scripts/browser-smoke-test.js`: browser smoke test

## Run locally

Serve the folder over HTTP. The game fetches `words.json`, so opening `index.html` directly from disk is not the intended path.

### Option 1: Start with the helper script

```bash
./start-server.sh
```

This starts:

```bash
python3 -m http.server 8000 --bind 0.0.0.0
```

Use a different port if needed:

```bash
./start-server.sh 9000
```

### Option 2: Start Python manually

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

## Build `words.json`

The builder now works locally by default:

- candidate words come from `/usr/share/dict/words`
- definitions come from local WordNet via `wn`
- output is written to `words.json`

Default run:

```bash
python3 scripts/build_fallback_words.py
```

That adds up to 10 new words to `words.json`.

Useful options:

```bash
python3 scripts/build_fallback_words.py 25
python3 scripts/build_fallback_words.py --candidates-file scripts/fallback-seed.txt
```

Notes:

- Existing words already present in `words.json` are skipped.
- The builder keeps going until it adds the requested number of new words or exhausts the candidate source.
- `HELLO` is treated as a required word and is preserved in the output.

## Test

Run the browser smoke test with:

```bash
make test-browser
```

## Notes about LAN access

- `localhost` only works on the machine running the server.
- Binding to `0.0.0.0` allows other devices on your LAN to connect.
- Both computers must be on the same local network unless you set up routing, tunneling, or port forwarding.
- Your firewall may need to allow incoming connections to `python3`.
- The local Python server is only for development and smoke testing, not production deployment.
