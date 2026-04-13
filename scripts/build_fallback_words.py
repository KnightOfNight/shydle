#!/usr/bin/env python3
"""Build a fallback JSON word list with definitions for the browser app."""

from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

WORD_LIST_API_URL = "https://random-word-api.herokuapp.com/all"
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "words.json"
DEFAULT_CANDIDATES_FILE = Path("/usr/share/dict/words")
WORDNET_COMMAND = "wn"
REQUIRED_WORDS = ("HELLO",)
REQUEST_TIMEOUT = 20
MAX_RETRIES = 6


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a fallback JSON file of five-letter words with definitions.",
    )
    parser.add_argument(
        "count",
        nargs="?",
        type=int,
        default=10,
        help="Number of new words to add to the output JSON. Defaults to 10.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output path for the generated JSON. Defaults to {DEFAULT_OUTPUT}.",
    )
    parser.add_argument(
        "--candidates-file",
        type=Path,
        default=DEFAULT_CANDIDATES_FILE,
        help=(
            "Optional newline-delimited candidate word file to use instead of the default local system dictionary. "
            f"Defaults to {DEFAULT_CANDIDATES_FILE}."
        ),
    )
    return parser.parse_args()


def fetch_json(url: str) -> object:
    delay = 1.0

    for attempt in range(MAX_RETRIES):
        print(f"Fetching {url} (attempt {attempt + 1}/{MAX_RETRIES})", file=sys.stderr)
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "wordle-fallback-builder/1.0"},
        )

        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404:
                raise

            if error.code == 429 or 500 <= error.code < 600:
                if attempt == MAX_RETRIES - 1:
                    raise
                print(
                    f"Retryable HTTP {error.code} for {url}; sleeping {delay:.1f}s before retry.",
                    file=sys.stderr,
                )
                time.sleep(delay)
                delay *= 2
                continue

            raise
        except urllib.error.URLError:
            if attempt == MAX_RETRIES - 1:
                raise
            print(
                f"Network error for {url}; sleeping {delay:.1f}s before retry.",
                file=sys.stderr,
            )
            time.sleep(delay)
            delay *= 2

    raise RuntimeError(f"Failed to fetch JSON from {url}")


def normalize_candidates(words: list[str]) -> list[str]:
    normalized = {
        word.strip().upper()
        for word in words
        if isinstance(word, str) and len(word.strip()) == 5 and word.strip().isalpha()
    }
    if not normalized:
        raise RuntimeError("No usable five-letter words were provided.")

    candidates = list(normalized)
    random.shuffle(candidates)
    return candidates


def load_candidates(candidates_file: Path | None) -> list[str]:
    if candidates_file:
        print(f"Loading candidates from {candidates_file}", file=sys.stderr)
        raw_words = candidates_file.read_text(encoding="utf-8").splitlines()
        candidates = normalize_candidates(raw_words)
        print(f"Loaded {len(candidates)} candidate words from file.", file=sys.stderr)
        return candidates

    print(f"Loading candidates from {WORD_LIST_API_URL}", file=sys.stderr)
    payload = fetch_json(WORD_LIST_API_URL)
    if not isinstance(payload, list):
        raise RuntimeError("Word list API did not return a list.")

    candidates = normalize_candidates(payload)
    print(f"Loaded {len(candidates)} candidate words from API.", file=sys.stderr)
    return candidates


def load_existing_entries(output_path: Path) -> list[dict[str, str]]:
    if not output_path.exists():
        print(f"No existing output at {output_path}", file=sys.stderr)
        return []

    print(f"Loading existing entries from {output_path}", file=sys.stderr)
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    raw_entries = payload if isinstance(payload, list) else payload.get("words")
    if not isinstance(raw_entries, list):
        raise RuntimeError(f"Existing output at {output_path} is not a valid word list.")

    entries: list[dict[str, str]] = []
    for entry in raw_entries:
        if not isinstance(entry, dict):
            continue

        word = entry.get("word")
        definition = entry.get("definition")
        if not isinstance(word, str) or not isinstance(definition, str):
            continue

        normalized_word = word.strip().upper()
        normalized_definition = definition.strip()
        if len(normalized_word) != 5 or not normalized_word.isalpha() or not normalized_definition:
            continue

        entries.append({
            "word": normalized_word,
            "definition": normalized_definition,
        })

    print(f"Loaded {len(entries)} existing entries.", file=sys.stderr)
    return entries


def get_wordnet_definition(word: str) -> str | None:
    if not shutil.which(WORDNET_COMMAND):
        raise RuntimeError("WordNet command 'wn' is not available.")

    print(f"Checking local WordNet definition for {word}", file=sys.stderr)
    result = subprocess.run(
        [WORDNET_COMMAND, word.lower(), "-over"],
        check=False,
        capture_output=True,
        text=True,
    )

    for line in result.stdout.splitlines():
        match = re.search(r"-- \((.+)\)$", line.strip())
        if match:
            definition = match.group(1).strip()
            if definition:
                print(f"Found local WordNet definition for {word}", file=sys.stderr)
                return definition

    print(
        f"No usable local WordNet definition found for {word} (exit code {result.returncode}).",
        file=sys.stderr,
    )
    return None


def fetch_definition(word: str) -> tuple[str, str | None]:
    definition = get_wordnet_definition(word)
    return word, definition


def ensure_required_entries(entries: list[dict[str, str]]) -> list[dict[str, str]]:
    seen_words = {entry["word"] for entry in entries}

    for word in REQUIRED_WORDS:
        if word in seen_words:
            continue

        print(f"Ensuring required word {word} is present.", file=sys.stderr)
        _, definition = fetch_definition(word)
        if not definition:
            raise RuntimeError(f"Required word {word} does not have a usable definition.")

        entries.append({
            "word": word,
            "definition": definition,
        })
        seen_words.add(word)

    return entries


def build_entries(count: int, candidates_file: Path | None, output_path: Path) -> list[dict[str, str]]:
    candidates = load_candidates(candidates_file)
    entries = ensure_required_entries(load_existing_entries(output_path))
    seen_words = {entry["word"] for entry in entries}
    initial_count = len(entries)

    print(
        f"Building fallback set by adding up to {count} new words from {len(candidates)} candidates.",
        file=sys.stderr,
    )

    for index, word in enumerate(candidates, start=1):
        if word in seen_words:
            print(f"[{index}/{len(candidates)}] Skipping {word}; already present in output.", file=sys.stderr)
            continue

        print(f"[{index}/{len(candidates)}] Processing {word}", file=sys.stderr)
        word, definition = fetch_definition(word)
        if definition and word not in seen_words:
            seen_words.add(word)
            entries.append({
                "word": word,
                "definition": definition,
            })
            print(
                f"Collected {len(entries) - initial_count}/{count} new words: {word}",
                file=sys.stderr,
            )
            if len(entries) - initial_count >= count:
                break

    added_count = len(entries) - initial_count
    if added_count < count:
        print(
            f"Seed list exhausted after adding {added_count} new words.",
            file=sys.stderr,
        )

    entries.sort(key=lambda entry: entry["word"])
    return entries


def main() -> int:
    args = parse_args()
    if args.count <= 0:
        raise SystemExit("count must be a positive integer")

    random.seed()
    entries = build_entries(args.count, args.candidates_file, args.output)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        json.dump({"words": entries}, handle, ensure_ascii=True, indent=2)
        handle.write("\n")

    print(f"Wrote {len(entries)} entries to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
