const WORD_LENGTH = 5;
const MAX_GUESSES = 5;
const GUESS_COUNT_COOKIE = "wordle_guess_count";
const GUESS_COUNT_STORAGE_KEY = "wordle_guess_count";
const PLAYED_WORDS_COOKIE = "wordle_played_words";
const PLAY_EVENTS_STORAGE_KEY = "wordle_play_events";
const WORDS_URL = "./words.json";
const WORDS_FETCH_TIMEOUT_MS = 2000;
const TEST_WIN_WORD = "HISHY";
const TEST_LOSE_WORD = "BYSHY";
const TEST_ERROR_WORD = "NOSHY";
const KEYBOARD_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

const board = document.getElementById("board");
const keyboard = document.getElementById("keyboard");
const enterKeyButton = document.getElementById("enter-key-button");
const clearRowButton = document.getElementById("clear-row-button");
const backspaceKeyButton = document.getElementById("backspace-key-button");
const hintButton = document.getElementById("hint-button");
const newGameButton = document.getElementById("new-game-button");
const settingsButton = document.getElementById("settings-button");
const guessCountSelect = document.getElementById("guess-count");
const settingsModal = document.getElementById("settings-modal");
const settingsModalBackdrop = document.getElementById("settings-modal-backdrop");
const settingsCloseButton = document.getElementById("settings-close-button");
const confirmModal = document.getElementById("confirm-modal");
const confirmModalBackdrop = document.getElementById("confirm-modal-backdrop");
const confirmCancelButton = document.getElementById("confirm-cancel-button");
const confirmAcceptButton = document.getElementById("confirm-accept-button");
const revealModal = document.getElementById("reveal-modal");
const revealModalBackdrop = document.getElementById("reveal-modal-backdrop");
const revealModalText = document.getElementById("reveal-modal-text");
const revealOkButton = document.getElementById("reveal-ok-button");
const winModal = document.getElementById("win-modal");
const winModalBackdrop = document.getElementById("win-modal-backdrop");
const winModalText = document.getElementById("win-modal-text");
const winNewGameButton = document.getElementById("win-new-game-button");
const loseModal = document.getElementById("lose-modal");
const loseModalBackdrop = document.getElementById("lose-modal-backdrop");
const loseModalText = document.getElementById("lose-modal-text");
const loseNewGameButton = document.getElementById("lose-new-game-button");
const noMoreHintsModal = document.getElementById("no-more-hints-modal");
const noMoreHintsModalBackdrop = document.getElementById("no-more-hints-modal-backdrop");
const noMoreHintsCloseButton = document.getElementById("no-more-hints-close-button");
const errorScreen = document.getElementById("error-screen");
const errorScreenTitle = document.getElementById("error-screen-title");
const errorScreenText = document.getElementById("error-screen-text");
const errorScreenReloadButton = document.getElementById("error-screen-reload-button");

let secretWord = "";
let currentGuess = "";
let currentRow = 0;
let gameOver = false;
let isRevealing = false;
let tileRows = [];
let answerWords = [];
let validGuessSet = new Set();
let dictionaryReady = false;
let isCheckingGuess = false;
let currentMaxGuesses = MAX_GUESSES;
let isModalOpen = false;
let previousFocus = null;
let gameStateVersion = 0;
let isLoadingHint = false;
let current24HourPlayCount = 0;
let hasCountedCurrentGame = false;
let revealedHintIndices = [];
let revealedCorrectIndices = new Set();
let currentRowInvalid = false;
let activeModalCleanup = null;
let activeModal = null;
const keyStates = new Map();

function getWebpageVersion() {
  const meta = document.querySelector('meta[name="webpage-version"]');
  return meta?.content || "";
}

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
  const answers = Array.isArray(payload?.answers) ? payload.answers : null;
  const guesses = Array.isArray(payload?.guesses) ? payload.guesses : null;
  if (!answers || !guesses) {
    throw new Error("Words payload must contain answers and guesses arrays.");
  }

  const normalize = (entries) => [...new Set(
    entries
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.trim().toUpperCase())
      .filter((entry) => /^[A-Z]{5}$/.test(entry))
  )];

  const normalizedAnswers = normalize(answers);
  const normalizedGuesses = normalize(guesses);

  if (normalizedAnswers.length === 0) {
    throw new Error("Answers list is empty.");
  }

  return {
    answers: normalizedAnswers,
    guesses: normalizedGuesses,
  };
}

async function loadWordsEntries(options = {}) {
  const { version = "" } = options;
  const wordsUrl = version
    ? `${WORDS_URL}?v=${encodeURIComponent(version)}`
    : WORDS_URL;
  const response = await fetchWithTimeout(wordsUrl);
  if (!response.ok) {
    throw new Error(`Words request failed with status ${response.status}`);
  }

  const payload = await response.json();
  const parsed = parseWordsPayload(payload);
  answerWords = parsed.answers;
  validGuessSet = new Set([...parsed.answers, ...parsed.guesses]);
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

function isSameLocalDay(timestamp, now = Date.now()) {
  const eventDate = new Date(timestamp);
  const currentDate = new Date(now);

  return eventDate.getFullYear() === currentDate.getFullYear()
    && eventDate.getMonth() === currentDate.getMonth()
    && eventDate.getDate() === currentDate.getDate();
}

function prunePlayEvents(events, now = Date.now()) {
  return events.filter((timestamp) =>
    Number.isInteger(timestamp) && timestamp <= now && isSameLocalDay(timestamp, now),
  );
}

function readPlayEventsStorage() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PLAY_EVENTS_STORAGE_KEY) || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return prunePlayEvents(parsed);
  } catch (error) {
    console.error(error);
    return [];
  }
}

function writePlayEventsStorage(events) {
  try {
    localStorage.setItem(PLAY_EVENTS_STORAGE_KEY, JSON.stringify(events));
  } catch (error) {
    console.error(error);
  }
}

function refresh24HourPlayCount() {
  const events = readPlayEventsStorage();
  current24HourPlayCount = events.length;
  writePlayEventsStorage(events);
  return current24HourPlayCount;
}

function recordPlayEvent() {
  const now = Date.now();
  const events = prunePlayEvents(readPlayEventsStorage(), now);
  events.push(now);
  current24HourPlayCount = events.length;
  writePlayEventsStorage(events);
  hasCountedCurrentGame = true;
  return current24HourPlayCount;
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

function updateClearRowButton() {
  const isActive = currentGuess.length > 0
    && !gameOver
    && !isRevealing
    && !isCheckingGuess
    && dictionaryReady;

  clearRowButton.disabled = !isActive;
  clearRowButton.classList.toggle("is-active", isActive);
}

function updateBackspaceButtonState() {
  const isActive = currentGuess.length > 0
    && !gameOver
    && !isRevealing
    && !isCheckingGuess
    && dictionaryReady;

  backspaceKeyButton.disabled = !isActive;
  backspaceKeyButton.classList.toggle("is-active", isActive);
}

function updateNewGameButtonState() {
  newGameButton.disabled = !(currentGuess.length > 0 || currentRow > 0 || gameOver);
}

function updateEnterButtonState() {
  const isActive = currentGuess.length === WORD_LENGTH
    && !gameOver
    && !isRevealing
    && !isCheckingGuess
    && dictionaryReady;

  enterKeyButton.disabled = !isActive;
  enterKeyButton.classList.toggle("is-active", isActive);
}

function clearInvalidRowState() {
  currentRowInvalid = false;
}

function hasAvailableHint() {
  if (!dictionaryReady || isLoadingHint || gameOver || isRevealing || isCheckingGuess || currentRow === 0) {
    return false;
  }

  const availableIndices = [0, 1, 2, 3, 4]
    .filter((index) => !revealedHintIndices.includes(index))
    .filter((index) => !revealedCorrectIndices.has(index))
    .filter((index) => !isLetterKnown(secretWord[index]));

  return availableIndices.length > 0 && getRemainingFreeHintCount() > 0;
}

function updateHintButtonState() {
  hintButton.disabled = !hasAvailableHint();
}

function setControlsDisabled(disabled) {
  guessCountSelect.disabled = disabled;
  clearRowButton.disabled = disabled || currentGuess.length === 0;
  clearRowButton.classList.toggle("is-active", !clearRowButton.disabled);
  backspaceKeyButton.disabled = disabled || currentGuess.length === 0;
  backspaceKeyButton.classList.toggle("is-active", !backspaceKeyButton.disabled);
  enterKeyButton.disabled = disabled || currentGuess.length !== WORD_LENGTH;
  enterKeyButton.classList.toggle("is-active", !enterKeyButton.disabled);
  hintButton.disabled = disabled || !hasAvailableHint();
  newGameButton.disabled = disabled || !(currentGuess.length > 0 || currentRow > 0 || gameOver);
}

function pickNextWord() {
  if (answerWords.length === 0) {
    throw new Error("No words are available.");
  }

  let playedWords = readPlayedWordsCookie()
    .filter((word) => answerWords.includes(word));
  let unplayedWords = answerWords.filter((word) => !playedWords.includes(word));

  if (unplayedWords.length === 0) {
    playedWords = [];
    unplayedWords = [...answerWords];
  }

  const word = unplayedWords[Math.floor(Math.random() * unplayedWords.length)];
  writePlayedWordsCookie([...playedWords, word]);
  return word;
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

function revealFreeLetter(index) {
  const letter = secretWord[index];

  if (statePriority("present") > statePriority(keyStates.get(letter))) {
    keyStates.set(letter, "present");
    const key = keyboard.querySelector(`[data-key="${letter}"]`);
    if (key) {
      key.classList.remove("correct", "present", "absent");
      key.classList.add("present");
    }
  }

  refreshCurrentRow();
}

function getKnownLetterCount() {
  let count = 0;

  keyStates.forEach((state) => {
    if (state === "correct" || state === "present") {
      count += 1;
    }
  });

  return count;
}

function isLetterKnown(letter) {
  const state = keyStates.get(letter);
  return state === "correct" || state === "present";
}

function getKnownWordLetterCount() {
  let count = 0;

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    const letter = secretWord[index];
    if (revealedCorrectIndices.has(index) || revealedHintIndices.includes(index) || isLetterKnown(letter)) {
      count += 1;
    }
  }

  return count;
}

function getRemainingFreeHintCount() {
  return Math.max(
    0,
    WORD_LENGTH - 1 - getKnownLetterCount(),
  );
}

function setHint() {
  const availableIndices = [0, 1, 2, 3, 4]
    .filter((index) => !revealedHintIndices.includes(index))
    .filter((index) => !revealedCorrectIndices.has(index))
    .filter((index) => !isLetterKnown(secretWord[index]));

  if (availableIndices.length === 0) {
    openNoMoreHintsModal();
    return;
  }

  if (getRemainingFreeHintCount() <= 0) {
    openNoMoreHintsModal();
    return;
  }

  const index = availableIndices[Math.floor(Math.random() * availableIndices.length)];

  if (!revealedHintIndices.includes(index)) {
    revealedHintIndices.push(index);
  }

  revealFreeLetter(index);
}

async function handleHintRequest() {
  if (!dictionaryReady || isLoadingHint) {
    return;
  }

  if (currentRow === 0) {
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

    setHint();
  } finally {
    isLoadingHint = false;
    updateHintButtonState();
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
    tile.classList.toggle("invalid", currentRowInvalid);
  });

  updateClearRowButton();
  updateBackspaceButtonState();
  updateEnterButtonState();
  updateHintButtonState();
  updateNewGameButtonState();
  updateActiveTile();
}

function clearCurrentRow() {
  if (currentGuess.length === 0 || gameOver || isRevealing || isCheckingGuess || !dictionaryReady) {
    updateClearRowButton();
    return;
  }

  clearInvalidRowState();
  currentGuess = "";
  refreshCurrentRow();
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
    clearInvalidRowState();
    currentGuess = currentGuess.slice(0, -1);
    refreshCurrentRow();
    return;
  }

  if (/^[A-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
    clearInvalidRowState();
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
    return;
  }

  const submissionVersion = gameStateVersion;
  isCheckingGuess = true;
  const isTestWinWord = currentGuess === TEST_WIN_WORD;
  const isTestLoseWord = currentGuess === TEST_LOSE_WORD;
  const isTestErrorWord = currentGuess === TEST_ERROR_WORD;

  const allowedGuess = (isTestWinWord || isTestLoseWord || isTestErrorWord)
    ? true
    : validGuessSet.has(currentGuess);
  if (submissionVersion !== gameStateVersion) {
    return;
  }

  isCheckingGuess = false;

  if (!allowedGuess) {
    currentRowInvalid = true;
    refreshCurrentRow();
    updateActiveTile();
    return;
  }

  if (isTestErrorWord) {
    openErrorScreen();
    return;
  }

  const guess = currentGuess;
  const answer = isTestWinWord ? guess : secretWord;
  const scores = scoreGuess(guess, answer);
  scores.forEach((state, index) => {
    if (state === "correct") {
      revealedCorrectIndices.add(index);
    }
  });
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
  updateHintButtonState();

  if (guess === answer) {
    if (!hasCountedCurrentGame) {
      recordPlayEvent();
    }
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      openWinModal(secretWord, () => {
        resetGame();
      });
      updateHintButtonState();
      updateActiveTile();
    }, 900);
    return;
  }

  if (isTestLoseWord) {
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      openLoseModal(secretWord, () => {
        resetGame();
      });
      updateHintButtonState();
      updateActiveTile();
    }, 900);
    return;
  }

  currentRow += 1;
  clearInvalidRowState();
  currentGuess = "";
  updateClearRowButton();
  updateBackspaceButtonState();
  updateEnterButtonState();

  if (currentRow === currentMaxGuesses) {
    gameOver = true;
    setTimeout(() => {
      isRevealing = false;
      openLoseModal(secretWord, () => {
        resetGame();
      });
      updateHintButtonState();
      updateActiveTile();
    }, 900);
    return;
  }

  setTimeout(() => {
    isRevealing = false;
    updateHintButtonState();
    updateActiveTile();
  }, 900);
}

async function resetGame(options = {}) {
  gameStateVersion += 1;
  const resetVersion = gameStateVersion;
  secretWord = "";
  currentGuess = "";
  currentRow = 0;
  gameOver = false;
  isRevealing = false;
  isCheckingGuess = false;
  isLoadingHint = false;
  hasCountedCurrentGame = false;
  revealedHintIndices = [];
  revealedCorrectIndices = new Set();
  currentRowInvalid = false;
  keyStates.clear();
  dictionaryReady = false;
  setControlsDisabled(true);
  initializeBoard();
  initializeKeyboard();

  secretWord = pickNextWord();

  if (resetVersion !== gameStateVersion) {
    return;
  }

  dictionaryReady = true;
  setControlsDisabled(false);
  updateHintButtonState();
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

function closeModal(options = {}) {
  const { restoreFocus = true } = options;

  isModalOpen = false;

  if (activeModal) {
    activeModal.classList.remove("is-open");
    activeModal.setAttribute("aria-hidden", "true");
  }

  if (activeModalCleanup) {
    activeModalCleanup();
    activeModalCleanup = null;
  }

  activeModal = null;

  if (restoreFocus && previousFocus && typeof previousFocus.focus === "function") {
    previousFocus.focus();
  }

  if (!restoreFocus && previousFocus && typeof previousFocus.blur === "function") {
    previousFocus.blur();
  }

  previousFocus = null;
}

function openModal({
  modal,
  initialFocus,
  bindings = [],
  onEscape,
  onEnter,
}) {
  if (isModalOpen) {
    return;
  }

  isModalOpen = true;
  activeModal = modal;
  previousFocus = document.activeElement;
  modal.classList.add("is-open");
  modal.setAttribute("aria-hidden", "false");

  const handleKeydown = (event) => {
    if (event.key === "Escape" && onEscape) {
      onEscape();
      return;
    }

    if (event.key === "Enter" && onEnter) {
      onEnter();
    }
  };

  bindings.forEach(({ element, event, handler }) => {
    element.addEventListener(event, handler);
  });
  document.addEventListener("keydown", handleKeydown);

  activeModalCleanup = () => {
    bindings.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    document.removeEventListener("keydown", handleKeydown);
  };

  if (initialFocus) {
    initialFocus.focus();
  }
}

function openSettingsModal() {
  guessCountSelect.value = String(currentMaxGuesses);

  const handleClose = () => {
    closeModal();
  };

  openModal({
    modal: settingsModal,
    initialFocus: settingsCloseButton,
    bindings: [
      { element: settingsModalBackdrop, event: "click", handler: handleClose },
      { element: settingsCloseButton, event: "click", handler: handleClose },
    ],
    onEscape: handleClose,
  });
}

function openConfirmModal(onConfirm) {
  const handleCancel = () => {
    closeModal();
  };

  const handleConfirm = () => {
    closeModal({ restoreFocus: false });
    onConfirm();
  };

  openModal({
    modal: confirmModal,
    initialFocus: confirmAcceptButton,
    bindings: [
      { element: confirmCancelButton, event: "click", handler: handleCancel },
      { element: confirmAcceptButton, event: "click", handler: handleConfirm },
      { element: confirmModalBackdrop, event: "click", handler: handleCancel },
    ],
    onEscape: handleCancel,
  });
}

function openRevealModal(word, onAcknowledge) {
  revealModalText.textContent = word ? word : "";

  const handleAcknowledge = () => {
    closeModal({ restoreFocus: false });
    onAcknowledge();
  };

  openModal({
    modal: revealModal,
    initialFocus: revealOkButton,
    bindings: [
      { element: revealOkButton, event: "click", handler: handleAcknowledge },
      { element: revealModalBackdrop, event: "click", handler: handleAcknowledge },
    ],
    onEscape: handleAcknowledge,
    onEnter: handleAcknowledge,
  });
}

function openWinModal(word, onNewGame) {
  winModalText.textContent = word ? `The word was ${word}.` : "";

  const handleNewGame = () => {
    closeModal({ restoreFocus: false });
    onNewGame();
  };

  openModal({
    modal: winModal,
    initialFocus: winNewGameButton,
    bindings: [
      { element: winNewGameButton, event: "click", handler: handleNewGame },
      { element: winModalBackdrop, event: "click", handler: handleNewGame },
    ],
    onEscape: handleNewGame,
    onEnter: handleNewGame,
  });
}

function openLoseModal(word, onNewGame) {
  loseModalText.textContent = word ? `The word was ${word}.` : "";

  const handleNewGame = () => {
    closeModal({ restoreFocus: false });
    onNewGame();
  };

  openModal({
    modal: loseModal,
    initialFocus: loseNewGameButton,
    bindings: [
      { element: loseNewGameButton, event: "click", handler: handleNewGame },
      { element: loseModalBackdrop, event: "click", handler: handleNewGame },
    ],
    onEscape: handleNewGame,
    onEnter: handleNewGame,
  });
}

function openNoMoreHintsModal() {
  const handleClose = () => {
    closeModal();
  };

  openModal({
    modal: noMoreHintsModal,
    initialFocus: noMoreHintsCloseButton,
    bindings: [
      { element: noMoreHintsCloseButton, event: "click", handler: handleClose },
      { element: noMoreHintsModalBackdrop, event: "click", handler: handleClose },
    ],
    onEscape: handleClose,
    onEnter: handleClose,
  });
}

function openErrorScreen(title = "Unable to load words.", text = "Please reload the page.") {
  dictionaryReady = false;
  gameOver = true;
  isCheckingGuess = false;
  isRevealing = false;
  isLoadingHint = false;
  setControlsDisabled(true);
  errorScreenTitle.textContent = title;
  errorScreenText.textContent = text;

  const handleReload = () => {
    window.location.reload();
  };

  openModal({
    modal: errorScreen,
    initialFocus: errorScreenReloadButton,
    bindings: [
      { element: errorScreenReloadButton, event: "click", handler: handleReload },
    ],
    onEscape: handleReload,
    onEnter: handleReload,
  });
}

function handleStartNewGame() {
  if (hasInProgressGame()) {
    const abandonedWord = secretWord;
    openConfirmModal(() => {
      openRevealModal(abandonedWord, () => {
        resetGame();
      });
    });
    return;
  }

  resetGame();
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
settingsButton.addEventListener("click", openSettingsModal);
hintButton.addEventListener("click", handleHintRequest);
enterKeyButton.addEventListener("click", () => handleKeyPress("ENTER"));
clearRowButton.addEventListener("click", clearCurrentRow);
backspaceKeyButton.addEventListener("click", () => handleKeyPress("BACK"));
guessCountSelect.addEventListener("change", () => {
  const nextGuessCount = Number(guessCountSelect.value);

  if (nextGuessCount === currentMaxGuesses) {
    closeModal();
    return;
  }

  closeModal({ restoreFocus: false });

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
  refresh24HourPlayCount();
  initializeBoard();
  initializeKeyboard();
  setControlsDisabled(true);
  await loadWordsEntries({ version: getWebpageVersion() });
  await resetGame();
}

initializeGame().catch((error) => {
  console.error(error);
  openErrorScreen();
});
