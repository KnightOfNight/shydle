#!/usr/bin/env python3
"""Build the runtime JSON word list for the browser app."""

from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "words.json"
DEFAULT_CANDIDATES_FILE = Path("/usr/share/dict/words")
WORDNET_COMMAND = "wn"
REQUIRED_WORDS = ("HELLO",)
MAX_WORD_COUNT = 10_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the runtime JSON word list of five-letter words.",
    )
    parser.add_argument(
        "count",
        nargs="?",
        type=int,
        default=MAX_WORD_COUNT,
        help=f"Maximum number of words to include in the output JSON. Defaults to {MAX_WORD_COUNT}.",
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
    if not candidates_file:
        raise RuntimeError("A local candidates file is required.")

    print(f"Loading candidates from {candidates_file}", file=sys.stderr)
    raw_words = candidates_file.read_text(encoding="utf-8").splitlines()
    candidates = normalize_candidates(raw_words)
    print(f"Loaded {len(candidates)} candidate words from file.", file=sys.stderr)
    return candidates


def load_existing_entries(output_path: Path) -> list[dict[str, str]]:
    if output_path.exists():
        print(f"Ignoring existing output at {output_path}; rebuilding from source.", file=sys.stderr)
    return []


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
        entries.append({
            "word": word,
            "definition": definition or "",
        })
        seen_words.add(word)

    return entries


def build_entries(count: int, candidates_file: Path | None, output_path: Path) -> list[dict[str, str]]:
    candidates = load_candidates(candidates_file)
    entries = ensure_required_entries(load_existing_entries(output_path))
    seen_words = {entry["word"] for entry in entries}
    target_count = min(count, MAX_WORD_COUNT)

    print(
        f"Building words.json with up to {target_count} words from {len(candidates)} candidates.",
        file=sys.stderr,
    )

    for index, word in enumerate(candidates, start=1):
        if word in seen_words:
            print(f"[{index}/{len(candidates)}] Skipping {word}; already selected.", file=sys.stderr)
            continue

        print(f"[{index}/{len(candidates)}] Processing {word}", file=sys.stderr)
        word, definition = fetch_definition(word)
        seen_words.add(word)
        entries.append({
            "word": word,
            "definition": definition or "",
        })
        print(
            f"Collected {len(entries)}/{target_count} words: {word}",
            file=sys.stderr,
        )
        if len(entries) >= target_count:
            break

    if len(entries) < target_count:
        print(
            f"Candidate list exhausted after collecting {len(entries)} words.",
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
