const WORD_LENGTH = 5;
const MAX_GUESSES = 5;
const GUESS_COUNT_COOKIE = "wordle_guess_count";
const GUESS_COUNT_STORAGE_KEY = "wordle_guess_count";
const PLAYED_WORDS_COOKIE = "wordle_played_words";
const WORDS_URL = "./words.json";
const WORDS_FETCH_TIMEOUT_MS = 2000;
const KEYBOARD_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

const board = document.getElementById("board");
const keyboard = document.getElementById("keyboard");
const enterKeyButton = document.getElementById("enter-key-button");
const backspaceKeyButton = document.getElementById("backspace-key-button");
const hintButton = document.getElementById("hint-button");
const hintMessage = document.getElementById("hint-message");
const messageSeparator = document.getElementById("message-separator");
const message = document.getElementById("message");
const newGameButton = document.getElementById("new-game-button");
const guessCountSelect = document.getElementById("guess-count");
const confirmModal = document.getElementById("confirm-modal");
const confirmModalBackdrop = document.getElementById("confirm-modal-backdrop");
const confirmCancelButton = document.getElementById("confirm-cancel-button");
const confirmAcceptButton = document.getElementById("confirm-accept-button");

let secretWord = "";
let currentGuess = "";
let currentRow = 0;
let gameOver = false;
let isRevealing = false;
let tileRows = [];
let dictionary = [];
let dictionarySet = new Set(dictionary);
let playableWords = [];
let dictionaryReady = false;
let isCheckingGuess = false;
let currentMaxGuesses = MAX_GUESSES;
let isModalOpen = false;
let previousFocus = null;
let gameStateVersion = 0;
let currentStatusMessage = "Type a five-letter word and press ENTER.";
let currentStatusHtml = "";
let isStatusDanger = false;
let currentHintHtml = "";
let isLoadingHint = false;
const keyStates = new Map();
const hintCache = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = WORDS_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Request timed out after ${timeoutMs}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseWordsPayload(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.words;
  if (!Array.isArray(entries)) {
    throw new Error("Words payload is not an array.");
  }

  return entries
    .filter((entry) => entry && typeof entry.word === "string" && typeof entry.definition === "string")
    .map((entry) => ({
      word: entry.word.trim().toUpperCase(),
      definition: entry.definition.trim(),
    }))
    .filter((entry) => /^[A-Z]{5}$/.test(entry.word) && entry.definition);
}

async function loadWordsEntries(options = {}) {
  const { cacheBust = false } = options;
  const wordsUrl = cacheBust
    ? `${WORDS_URL}?v=${Math.floor(Date.now() / 1000)}`
    : WORDS_URL;
  const response = await fetchWithTimeout(wordsUrl);
  if (!response.ok) {
    throw new Error(`Words request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const entries = parseWordsPayload(payload);
  if (entries.length === 0) {
    throw new Error("Words file is empty.");
  }

  playableWords = entries.map((entry) => entry.word);
  dictionary = [...playableWords];
  dictionarySet = new Set(dictionary);

  hintCache.clear();

  entries.forEach((entry) => {
    hintCache.set(entry.word, entry.definition);
  });
}

function readGuessCountCookie() {
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${GUESS_COUNT_COOKIE}=`));

  if (!cookie) {
    return null;
  }

  const value = Number(cookie.split("=")[1]);
  if (!Number.isInteger(value) || value < 2 || value > 7) {
    return null;
  }

  return value;
}

function readPlayedWordsCookie() {
  const cookie = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${PLAYED_WORDS_COOKIE}=`));

  if (!cookie) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(cookie.split("=")[1]));
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((word) => typeof word === "string" && /^[A-Z]{5}$/.test(word));
  } catch (error) {
    console.error(error);
    return [];
  }
}

function writePlayedWordsCookie(words) {
  document.cookie = `${PLAYED_WORDS_COOKIE}=${encodeURIComponent(JSON.stringify(words))}; max-age=31536000; path=/; SameSite=Lax`;
}

function readGuessCountStorage() {
  try {
    const value = Number(localStorage.getItem(GUESS_COUNT_STORAGE_KEY));
    if (!Number.isInteger(value) || value < 2 || value > 7) {
      return null;
    }

    return value;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function writeGuessCountCookie(value) {
  document.cookie = `${GUESS_COUNT_COOKIE}=${value}; max-age=31536000; path=/; SameSite=Lax`;
}

function writeGuessCountStorage(value) {
  try {
    localStorage.setItem(GUESS_COUNT_STORAGE_KEY, String(value));
  } catch (error) {
    console.error(error);
  }
}

function initializeGuessCountSetting() {
  const savedGuessCount = readGuessCountStorage() ?? readGuessCountCookie();
  const initialGuessCount = savedGuessCount ?? MAX_GUESSES;
  guessCountSelect.value = String(initialGuessCount);
  currentMaxGuesses = initialGuessCount;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderMessages() {
  const hasHint = Boolean(currentHintHtml);

  if (currentHintHtml) {
    hintMessage.innerHTML = currentHintHtml;
    hintMessage.classList.remove("is-hidden");
  } else {
    hintMessage.innerHTML = "";
    hintMessage.classList.add("is-hidden");
  }

  message.classList.toggle("message-danger", isStatusDanger);
  const statusMarkup = currentStatusHtml || escapeHtml(currentStatusMessage);
  const hasStatus = Boolean(statusMarkup);
  messageSeparator.classList.toggle("is-hidden", !(hasHint && hasStatus));
  message.innerHTML = isStatusDanger
    ? `<strong>${statusMarkup}</strong>`
    : statusMarkup;
}

function setControlsDisabled(disabled) {
  guessCountSelect.disabled = disabled;
}

function pickNextWord() {
  if (dictionary.length === 0) {
    throw new Error("No words are available.");
  }

  let playedWords = readPlayedWordsCookie()
    .filter((word) => dictionarySet.has(word));
  let unplayedWords = dictionary.filter((word) => !playedWords.includes(word));

  if (unplayedWords.length === 0) {
    playedWords = [];
    unplayedWords = [...dictionary];
  }

  const word = unplayedWords[Math.floor(Math.random() * unplayedWords.length)];
  writePlayedWordsCookie([...playedWords, word]);
  return word;
}

async function isAllowedGuess(word) {
  return dictionarySet.has(word);
}

function initializeBoard() {
  board.innerHTML = "";
  tileRows = [];

  for (let rowIndex = 0; rowIndex < currentMaxGuesses; rowIndex += 1) {
    const row = document.createElement("div");
    row.className = "board-row";

    const tiles = [];
    for (let columnIndex = 0; columnIndex < WORD_LENGTH; columnIndex += 1) {
      const tile = document.createElement("div");
      tile.className = "tile";
      tile.setAttribute("aria-label", `Row ${rowIndex + 1} column ${columnIndex + 1}`);
      row.appendChild(tile);
      tiles.push(tile);
    }

    board.appendChild(row);
    tileRows.push(tiles);
  }
}

function initializeKeyboard() {
  keyboard.innerHTML = "";

  KEYBOARD_ROWS.forEach((rowKeys) => {
    const row = document.createElement("div");
    row.className = "keyboard-row";

    rowKeys.forEach((label) => {
      const key = document.createElement("button");
      key.type = "button";
      key.className = "key";
      key.dataset.key = label;
      key.textContent = label;

      key.addEventListener("click", () => handleKeyPress(label));
      row.appendChild(key);
    });

    keyboard.appendChild(row);
  });
}

function clearHint() {
  currentHintHtml = "";
}

function setHint(definition) {
  if (!definition) {
    currentHintHtml = "<em>No hints this time. You're own your own.</em>";
    renderMessages();
    return;
  }

  currentHintHtml = `<em>${escapeHtml(definition)}</em>`;
  renderMessages();
}

function setMessage(text) {
  currentStatusMessage = text;
  currentStatusHtml = "";
  isStatusDanger = text === "1 guess remaining.";
  renderMessages();
}

function setMessageHtml(html, text) {
  currentStatusHtml = html;
  currentStatusMessage = text;
  isStatusDanger = text === "1 guess remaining.";
  renderMessages();
}

function getSolvedMessage(guessNumber) {
  if (guessNumber === 1) {
    return "You solved the puzzle in one guess! INCONCEIVABLE!";
  }

  if (guessNumber === 2 && currentMaxGuesses >= 3) {
    return "You solved the puzzle in 2 guesses!";
  }

  if (guessNumber === currentMaxGuesses) {
    return "You solved it; but only just!";
  }

  return `You solved the puzzle in ${guessNumber} guesses.`;
}

async function handleHintRequest() {
  if (!dictionaryReady || isLoadingHint) {
    return;
  }

  const requestedWord = secretWord;
  const requestVersion = gameStateVersion;
  isLoadingHint = true;
  hintButton.disabled = true;

  try {
    if (requestVersion !== gameStateVersion || requestedWord !== secretWord) {
      return;
    }

    setHint(hintCache.get(requestedWord));
  } finally {
    isLoadingHint = false;
    hintButton.disabled = false;
  }
}

function updateActiveTile() {
  tileRows.flat().forEach((tile) => {
    tile.classList.remove("active");
  });

  if (gameOver || isRevealing || isCheckingGuess || !dictionaryReady) {
    return;
  }

  const row = tileRows[currentRow];
  if (!row) {
    return;
  }

  const activeIndex = Math.min(currentGuess.length, WORD_LENGTH - 1);
  const activeTile = row[activeIndex];
  if (activeTile && !activeTile.classList.contains("revealed")) {
    activeTile.classList.add("active");
  }
}

function refreshCurrentRow() {
  const row = tileRows[currentRow];
  if (!row) {
    return;
  }

  row.forEach((tile, index) => {
    const letter = currentGuess[index] || "";
    tile.textContent = letter;
    tile.classList.toggle("filled", Boolean(letter));
  });

  updateActiveTile();
}

function handleKeyPress(key) {
  if (gameOver || isRevealing || isCheckingGuess || !dictionaryReady) {
    return;
  }

  if (key === "ENTER") {
    submitGuess();
    return;
  }

  if (key === "BACK") {
    currentGuess = currentGuess.slice(0, -1);
    refreshCurrentRow();
    return;
  }

  if (/^[A-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
    currentGuess += key;
    refreshCurrentRow();

    const tile = tileRows[currentRow][currentGuess.length - 1];
    tile.classList.remove("pop");
    void tile.offsetWidth;
    tile.classList.add("pop");
  }
}

function scoreGuess(guess, answer) {
  const result = Array(WORD_LENGTH).fill("absent");
  const counts = new Map();

  for (const letter of answer) {
    counts.set(letter, (counts.get(letter) || 0) + 1);
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (guess[index] === answer[index]) {
      result[index] = "correct";
      counts.set(guess[index], counts.get(guess[index]) - 1);
    }
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    const letter = guess[index];
    if (result[index] !== "absent") {
      continue;
    }

    if ((counts.get(letter) || 0) > 0) {
      result[index] = "present";
      counts.set(letter, counts.get(letter) - 1);
    }
  }

  return result;
}

function statePriority(state) {
  if (state === "correct") {
    return 3;
  }
  if (state === "present") {
    return 2;
  }
  if (state === "absent") {
    return 1;
  }
  return 0;
}

function updateKeyboard(guess, scores) {
  guess.split("").forEach((letter, index) => {
    const nextState = scores[index];
    const previousState = keyStates.get(letter);

    if (statePriority(nextState) <= statePriority(previousState)) {
      return;
    }

    keyStates.set(letter, nextState);
    const key = keyboard.querySelector(`[data-key="${letter}"]`);
    if (!key) {
      return;
    }

    key.classList.remove("correct", "present", "absent");
    key.classList.add(nextState);
  });
}

async function submitGuess() {
  if (currentGuess.length !== WORD_LENGTH) {
    setMessage("Your guess needs five letters.");
    return;
  }

  const submissionVersion = gameStateVersion;
  isCheckingGuess = true;
  setMessage("Checking word.");

  const allowedGuess = await isAllowedGuess(currentGuess);
  if (submissionVersion !== gameStateVersion) {
    return;
  }

  isCheckingGuess = false;

  if (!allowedGuess) {
    setMessageHtml(
      `<em>${escapeHtml(currentGuess)}</em> is not in the dictionary.`,
      `${currentGuess} is not in the dictionary.`,
    );
    updateActiveTile();
    return;
  }

  const guess = currentGuess;
  const scores = scoreGuess(guess, secretWord);
  const row = tileRows[currentRow];
  isRevealing = true;
  updateActiveTile();

  row.forEach((tile, index) => {
    const state = scores[index];

    setTimeout(() => {
      tile.classList.add("flip");
      tile.classList.add("revealed", state);
      tile.classList.remove("filled");
    }, index * 180);

    setTimeout(() => {
      tile.classList.remove("flip");
    }, index * 180 + 420);
  });

  updateKeyboard(guess, scores);

  if (guess === secretWord) {
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      clearHint();
      setMessage(getSolvedMessage(currentRow + 1));
      updateActiveTile();
    }, 900);
    return;
  }

  currentRow += 1;
  currentGuess = "";

  if (currentRow === currentMaxGuesses) {
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      setMessage(`Out of guesses. The word was ${secretWord}.`);
      updateActiveTile();
    }, 900);
    return;
  }

  setTimeout(() => {
    isRevealing = false;
    const guessesLeft = currentMaxGuesses - currentRow;
    setMessage(`${guessesLeft} ${guessesLeft === 1 ? "guess" : "guesses"} remaining.`);
    updateActiveTile();
  }, 900);
}

async function resetGame(options = {}) {
  const {
    reloadWords = false,
    selectingMessage = "Choosing puzzle word.",
    readyMessage = "Type a five-letter word and press ENTER.",
  } = options;

  gameStateVersion += 1;
  const resetVersion = gameStateVersion;
  secretWord = "";
  currentGuess = "";
  currentRow = 0;
  gameOver = false;
  isRevealing = false;
  isCheckingGuess = false;
  isLoadingHint = false;
  keyStates.clear();
  clearHint();
  hintButton.disabled = false;
  dictionaryReady = false;
  setControlsDisabled(true);
  setMessage(selectingMessage);
  initializeBoard();
  initializeKeyboard();

  if (reloadWords) {
    try {
      setMessage("Reloading words.");
      await loadWordsEntries({ cacheBust: true });
      setMessage(selectingMessage);
    } catch (error) {
      console.error(error);
      setMessage("Unable to reload words. Using current word list.");
    }
  }

  secretWord = pickNextWord();

  if (resetVersion !== gameStateVersion) {
    return;
  }

  dictionaryReady = true;
  setControlsDisabled(false);
  if (readyMessage) {
    setMessage(readyMessage);
  }
  updateActiveTile();
}

function hasInProgressGame() {
  return !gameOver && (currentRow > 0 || currentGuess.length > 0);
}

function applyGuessCountChange(nextGuessCount) {
  currentMaxGuesses = nextGuessCount;
  guessCountSelect.value = String(nextGuessCount);
  writeGuessCountCookie(currentMaxGuesses);
  writeGuessCountStorage(currentMaxGuesses);
  resetGame();
}

function closeConfirmModal(restoreFocus = true) {
  isModalOpen = false;
  confirmModal.classList.remove("is-open");
  confirmModal.setAttribute("aria-hidden", "true");

  if (restoreFocus && previousFocus && typeof previousFocus.focus === "function") {
    previousFocus.focus();
  }

  if (!restoreFocus && previousFocus && typeof previousFocus.blur === "function") {
    previousFocus.blur();
  }

  previousFocus = null;
}

function openConfirmModal(onConfirm) {
  if (isModalOpen) {
    return;
  }

  isModalOpen = true;
  previousFocus = document.activeElement;
  confirmModal.classList.add("is-open");
  confirmModal.setAttribute("aria-hidden", "false");

  const handleCancel = () => {
    cleanup();
    closeConfirmModal();
  };

  const handleConfirm = () => {
    cleanup();
    closeConfirmModal(false);
    onConfirm();
  };

  const handleKeydown = (event) => {
    if (event.key === "Escape") {
      handleCancel();
    }
  };

  const cleanup = () => {
    confirmCancelButton.removeEventListener("click", handleCancel);
    confirmAcceptButton.removeEventListener("click", handleConfirm);
    confirmModalBackdrop.removeEventListener("click", handleCancel);
    document.removeEventListener("keydown", handleKeydown);
  };

  confirmCancelButton.addEventListener("click", handleCancel);
  confirmAcceptButton.addEventListener("click", handleConfirm);
  confirmModalBackdrop.addEventListener("click", handleCancel);
  document.addEventListener("keydown", handleKeydown);
  confirmAcceptButton.focus();
}

function handleStartNewGame() {
  if (hasInProgressGame()) {
    openConfirmModal(() => {
      resetGame({ reloadWords: true });
    });
    return;
  }

  resetGame({ reloadWords: true });
}

document.addEventListener("keydown", (event) => {
  if (isModalOpen) {
    return;
  }

  const key = event.key.toUpperCase();

  if (key === "ENTER") {
    event.preventDefault();
    handleKeyPress("ENTER");
    return;
  }

  if (key === "BACKSPACE") {
    event.preventDefault();
    handleKeyPress("BACK");
    return;
  }

  if (/^[A-Z]$/.test(key)) {
    event.preventDefault();
    handleKeyPress(key);
  }
});

newGameButton.addEventListener("click", handleStartNewGame);
hintButton.addEventListener("click", handleHintRequest);
enterKeyButton.addEventListener("click", () => handleKeyPress("ENTER"));
backspaceKeyButton.addEventListener("click", () => handleKeyPress("BACK"));
guessCountSelect.addEventListener("change", () => {
  const nextGuessCount = Number(guessCountSelect.value);

  if (nextGuessCount === currentMaxGuesses) {
    return;
  }

  if (hasInProgressGame()) {
    guessCountSelect.value = String(currentMaxGuesses);
    openConfirmModal(() => {
      applyGuessCountChange(nextGuessCount);
    });
    return;
  }

applyGuessCountChange(nextGuessCount);
});

async function initializeGame() {
  initializeGuessCountSetting();
  initializeBoard();
  initializeKeyboard();
  setControlsDisabled(true);
  setMessage("Loading words.");
  await loadWordsEntries();
  await resetGame();
}

initializeGame().catch((error) => {
  console.error(error);
  setMessage("Unable to load words.");
});
