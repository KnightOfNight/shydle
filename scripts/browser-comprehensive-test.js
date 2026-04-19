"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const SERVER_START_TIMEOUT_MS = 10_000;
const CHROME_START_TIMEOUT_MS = 15_000;
const PAGE_LOAD_WAIT_MS = 2_500;
const INITIALIZE_TIMEOUT_MS = 20_000;
const REVEAL_WAIT_MS = 1_050;

function parseArgs(argv) {
  const options = {
    python: "python3",
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    serverPort: 8123,
    debugPort: 9222,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--python") {
      options.python = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--chrome") {
      options.chrome = argv[index + 1];
      index += 1;
      continue;
    }

    if (token === "--server-port") {
      options.serverPort = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (token === "--debug-port") {
      options.debugPort = Number(argv[index + 1]);
      index += 1;
    }
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOutput(child, matcher, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let settled = false;

    if (matcher.test(child.outputBuffer || "")) {
      resolve(child.outputBuffer);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);

    const onData = (chunk) => {
      const text = chunk.toString();
      if (matcher.test(text)) {
        cleanup();
        settled = true;
        resolve(text);
      }
    };

    const onExit = (code, signal) => {
      if (!settled) {
        cleanup();
        reject(new Error(`${label} exited before becoming ready (code=${code}, signal=${signal})`));
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", onExit);
  });
}

function spawnLoggedProcess(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.outputBuffer = "";

  child.stdout.on("data", (chunk) => {
    child.outputBuffer += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    child.outputBuffer += chunk;
    process.stderr.write(chunk);
  });

  return child;
}

async function createDevToolsSession(targetUrl, remoteBaseUrl) {
  const targetResponse = await fetch(
    `${remoteBaseUrl}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: "PUT" },
  );

  if (!targetResponse.ok) {
    throw new Error(`Failed to create Chrome target: HTTP ${targetResponse.status}`);
  }

  const target = await targetResponse.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;

  socket.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (!payload.id) {
      return;
    }

    const resolver = pending.get(payload.id);
    if (!resolver) {
      return;
    }

    pending.delete(payload.id);
    if (payload.error) {
      resolver.reject(new Error(payload.error.message));
      return;
    }

    resolver.resolve(payload.result);
  };

  await new Promise((resolve, reject) => {
    socket.onerror = reject;
    socket.onopen = resolve;
  });

  async function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId + 1;
      nextId = id;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  await send("Page.enable");
  await send("Runtime.enable");

  return {
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });

      if (result.exceptionDetails) {
        throw new Error(`Evaluation failed for expression: ${expression}`);
      }

      return result.result.value;
    },
    close() {
      socket.close();
    },
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForCondition(session, expression, timeoutMs, label, intervalMs = 100) {
  const start = Date.now();

  while (true) {
    const result = await session.evaluate(expression);
    if (result) {
      return result;
    }

    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} did not become true within ${timeoutMs}ms`);
    }

    await sleep(intervalMs);
  }
}

async function waitForReady(session) {
  await sleep(PAGE_LOAD_WAIT_MS);
  await waitForCondition(
    session,
    `typeof dictionaryReady !== "undefined" ? dictionaryReady : false`,
    INITIALIZE_TIMEOUT_MS,
    "Dictionary readiness",
    250,
  );
}

async function resetToKnownDictionary(session, words, secret = null) {
  const entriesJson = JSON.stringify(words);
  const secretValue = secret ? JSON.stringify(secret) : "null";
  await session.evaluate(`(() => {
    const entries = ${entriesJson}.map((entry) => entry.word);
    answerWords = [...entries];
    validGuessSet = new Set(entries);
    document.cookie = "wordle_played_words=" + encodeURIComponent(JSON.stringify([])) + "; path=/; SameSite=Lax";
    return resetGame().then(() => {
      if (${secretValue} !== null) {
        secretWord = ${secretValue};
      }
    });
  })()`);
}

async function runComprehensiveChecks(appUrl, remoteBaseUrl) {
  const session = await createDevToolsSession(appUrl, remoteBaseUrl);

  try {
    await waitForReady(session);

    const initial = await session.evaluate(`(() => ({
      title: document.querySelector(".app-title")?.textContent.trim(),
      rows: document.querySelectorAll(".board-row").length,
      dictionaryReady,
      currentMaxGuesses,
      modalOpen: isModalOpen
    }))()`);
    assert(initial.title === "SHYDLE", `Unexpected title: ${initial.title}`);
    assert(initial.rows === initial.currentMaxGuesses, "Board rows do not match currentMaxGuesses on load");
    assert(initial.dictionaryReady === true, "Dictionary is not ready after initialization");
    assert(initial.modalOpen === false, "Modal should not be open on initial load");

    await session.evaluate(`settingsButton.click()`);
    const settingsOpen = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      settingsOpen: settingsModal.classList.contains("is-open"),
      activeId: document.activeElement?.id
    }))()`);
    assert(settingsOpen.modalOpen === true, "Settings button did not open the modal");
    assert(settingsOpen.settingsOpen === true, "Settings modal is not visibly open");
    assert(settingsOpen.activeId === "settings-close-button", `Expected Close Settings to be focused, got ${settingsOpen.activeId}`);

    await session.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await sleep(100);
    const settingsClosedByEscape = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      settingsOpen: settingsModal.classList.contains("is-open")
    }))()`);
    assert(settingsClosedByEscape.modalOpen === false, "Escape did not close settings modal");
    assert(settingsClosedByEscape.settingsOpen === false, "Settings modal stayed open after Escape");

    await session.evaluate(`settingsButton.click()`);
    await session.evaluate(`settingsCloseButton.click()`);
    await sleep(100);
    const settingsClosedByButton = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      settingsOpen: settingsModal.classList.contains("is-open")
    }))()`);
    assert(settingsClosedByButton.modalOpen === false, "Close Settings button did not close modal");
    assert(settingsClosedByButton.settingsOpen === false, "Settings modal stayed open after Close Settings");

    const targetGuessCount = await session.evaluate(`currentMaxGuesses === 7 ? 6 : 7`);
    await session.evaluate(`(() => {
      settingsButton.click();
      guessCountSelect.value = "${targetGuessCount}";
      guessCountSelect.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await sleep(150);
    const guessCountApplied = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      currentMaxGuesses,
      rows: document.querySelectorAll(".board-row").length,
      localValue: localStorage.getItem("wordle_guess_count"),
      cookie: document.cookie
    }))()`);
    assert(guessCountApplied.modalOpen === false, "Settings modal should close after immediate guess-count change");
    assert(
      guessCountApplied.currentMaxGuesses === targetGuessCount,
      `Expected currentMaxGuesses ${targetGuessCount}, got ${guessCountApplied.currentMaxGuesses}`,
    );
    assert(
      guessCountApplied.rows === targetGuessCount,
      `Expected ${targetGuessCount} board rows after settings change, got ${guessCountApplied.rows}`,
    );
    assert(
      guessCountApplied.localValue === String(targetGuessCount),
      `Expected stored guess count ${targetGuessCount}, got ${guessCountApplied.localValue}`,
    );
    assert(
      guessCountApplied.cookie.includes(`wordle_guess_count=${targetGuessCount}`),
      `Guess-count cookie did not persist ${targetGuessCount}: ${guessCountApplied.cookie}`,
    );

    await session.evaluate(`(() => {
      currentGuess = "AB";
      refreshCurrentRow();
      handleKeyPress("ENTER");
    })()`);
    const shortEnterIgnored = await session.evaluate(`(() => ({
      currentGuess,
      currentRow
    }))()`);
    assert(shortEnterIgnored.currentGuess === "AB", `Short ENTER mutated currentGuess: ${shortEnterIgnored.currentGuess}`);
    assert(shortEnterIgnored.currentRow === 0, `Short ENTER advanced row unexpectedly: ${shortEnterIgnored.currentRow}`);

    await session.evaluate(`(() => {
      currentGuess = "";
      refreshCurrentRow();
      handleHintRequest();
    })()`);

    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
      { word: "ALERT", definition: "" },
    ], "ALERT");
    await session.evaluate(`(() => {
      currentGuess = "CRANE";
      refreshCurrentRow();
      submitGuess();
    })()`);
    await sleep(REVEAL_WAIT_MS);
    const clearedAfterAdvance = await session.evaluate(`(() => ({ currentRow }))()`);
    assert(clearedAfterAdvance.currentRow === 1, `Expected move to row 1, got ${clearedAfterAdvance.currentRow}`);

    await resetToKnownDictionary(session, [
      { word: "ABACK", definition: "Definition test text." },
      { word: "CRANE", definition: "" },
    ], "ABACK");
    await session.evaluate(`(() => {
      currentRow = 1;
      currentGuess = "";
      revealedHintIndices = [];
      revealedCorrectIndices = new Set();
      keyStates.clear();
      initializeKeyboard();
      handleHintRequest();
    })()`);
    const hintedWordStillUsesLetterHint = await session.evaluate(`(() => ({
      presentKeys: Array.from(document.querySelectorAll(".key.present")).map((key) => key.dataset.key),
      revealedHintCount: revealedHintIndices.length
    }))()`);
    assert(
      hintedWordStillUsesLetterHint.presentKeys.length === 1,
      `Expected one yellow keyboard key for defined-word hint, got ${hintedWordStillUsesLetterHint.presentKeys.length}`,
    );
    assert(
      hintedWordStillUsesLetterHint.revealedHintCount === 1,
      `Expected one recorded hint for defined-word hint, got ${hintedWordStillUsesLetterHint.revealedHintCount}`,
    );

    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
      { word: "ALERT", definition: "" },
    ], "CRANE");
    await session.evaluate(`(() => {
      currentRow = 1;
      currentGuess = "";
      revealedHintIndices = [];
      revealedCorrectIndices = new Set();
      keyStates.clear();
      initializeKeyboard();
      handleHintRequest();
    })()`);
    const freeLetterHint = await session.evaluate(`(() => ({
      presentKeys: Array.from(document.querySelectorAll(".key.present")).map((key) => key.dataset.key),
      revealedHintCount: revealedHintIndices.length
    }))()`);
    assert(freeLetterHint.presentKeys.length === 1, `Expected one yellow keyboard key from free-letter hint, got ${freeLetterHint.presentKeys.length}`);
    assert(freeLetterHint.revealedHintCount === 1, `Expected one recorded free-letter hint, got ${freeLetterHint.revealedHintCount}`);

    await session.evaluate(`(() => {
      keyStates.clear();
      [["C", "correct"], ["R", "correct"], ["A", "correct"], ["N", "present"]]
        .forEach(([letter, state]) => keyStates.set(letter, state));
      handleHintRequest();
    })()`);
    const noMoreFreeLetters = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      modalVisible: document.querySelector("#no-more-hints-modal")?.classList.contains("is-open"),
      title: document.querySelector("#no-more-hints-modal-title")?.textContent.trim(),
      text: document.querySelector("#no-more-hints-modal-text")?.textContent.trim()
    }))()`);
    assert(
      noMoreFreeLetters.modalOpen === true && noMoreFreeLetters.modalVisible === true,
      "Expected no-more-hints modal to open",
    );
    assert(noMoreFreeLetters.title === "No more hints!", `Unexpected no-more-hints title: ${noMoreFreeLetters.title}`);
    assert(
      noMoreFreeLetters.text === "I've told you all I can. It's up to you now!",
      `Unexpected no-more-hints text: ${noMoreFreeLetters.text}`,
    );
    await session.evaluate(`noMoreHintsCloseButton.click()`);
    await sleep(100);

    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
    ], "CRANE");
    await session.evaluate(`(() => {
      currentGuess = "QQQQQ";
      refreshCurrentRow();
      submitGuess();
    })()`);
    const invalidGuess = await session.evaluate(`(() => ({
      currentRow,
      currentGuess,
      invalidTiles: Array.from(document.querySelectorAll(".board-row:first-child .tile.invalid")).length
    }))()`);
    assert(invalidGuess.currentRow === 0, `Invalid guess advanced row unexpectedly: ${invalidGuess.currentRow}`);
    assert(invalidGuess.currentGuess === "QQQQQ", `Invalid guess should leave the guess in place, got ${invalidGuess.currentGuess}`);
    assert(invalidGuess.invalidTiles === 5, `Expected whole row to be marked invalid, got ${invalidGuess.invalidTiles} tiles`);

    await session.evaluate(`handleKeyPress("BACK")`);
    const invalidGuessAfterBackspace = await session.evaluate(`(() => ({
      currentGuess,
      invalidTiles: Array.from(document.querySelectorAll(".board-row:first-child .tile.invalid")).length
    }))()`);
    assert(invalidGuessAfterBackspace.currentGuess === "QQQQ", `Expected backspace to trim guess after invalid row, got ${invalidGuessAfterBackspace.currentGuess}`);
    assert(invalidGuessAfterBackspace.invalidTiles === 0, `Expected invalid row styling to clear after backspace, got ${invalidGuessAfterBackspace.invalidTiles}`);

    await session.evaluate(`localStorage.removeItem("wordle_play_events"); refresh24HourPlayCount();`);
    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
    ], "CRANE");
    await session.evaluate(`(() => {
      currentGuess = "BYSHY";
      refreshCurrentRow();
      submitGuess();
    })()`);
    await sleep(REVEAL_WAIT_MS);
    const loseOverride = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      loseOpen: loseModal.classList.contains("is-open"),
      loseTitle: document.querySelector("#lose-modal-title")?.textContent.trim(),
      loseText: document.querySelector("#lose-modal-text")?.textContent.trim(),
      playEvents: JSON.parse(localStorage.getItem("wordle_play_events") || "[]").length
    }))()`);
    assert(loseOverride.modalOpen === true, "BYSHY did not open a modal");
    assert(loseOverride.loseOpen === true, "BYSHY did not open the lose modal");
    assert(loseOverride.loseTitle === "SORRY YOU LOST.", `Unexpected lose title: ${loseOverride.loseTitle}`);
    assert(loseOverride.loseText === "The word was CRANE.", `Unexpected lose text: ${loseOverride.loseText}`);
    assert(loseOverride.playEvents === 0, `Loss should not increment win count, got ${loseOverride.playEvents}`);
    await session.evaluate(`loseNewGameButton.click()`);
    await sleep(150);

    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
    ], "CRANE");
    await session.evaluate(`(() => {
      currentGuess = "HISHY";
      refreshCurrentRow();
      submitGuess();
    })()`);
    await sleep(REVEAL_WAIT_MS);
    const winOverride = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      winOpen: winModal.classList.contains("is-open"),
      winTitle: document.querySelector("#win-modal-title")?.textContent.trim(),
      winText: document.querySelector("#win-modal-text")?.textContent.trim(),
      playEvents: JSON.parse(localStorage.getItem("wordle_play_events") || "[]").length
    }))()`);
    assert(winOverride.modalOpen === true, "HISHY did not open a modal");
    assert(winOverride.winOpen === true, "HISHY did not open the win modal");
    assert(winOverride.winTitle === "YOU WIN!", `Unexpected win title: ${winOverride.winTitle}`);
    assert(winOverride.winText === "The word was CRANE.", `Unexpected win text: ${winOverride.winText}`);
    assert(winOverride.playEvents === 1, `Win should increment win count once, got ${winOverride.playEvents}`);
    await session.evaluate(`winNewGameButton.click()`);
    await sleep(150);

    await resetToKnownDictionary(session, [
      { word: "ALERT", definition: "" },
      { word: "CRANE", definition: "" },
    ], "ALERT");
    await session.evaluate(`(() => {
      currentMaxGuesses = 2;
      guessCountSelect.value = "2";
      initializeBoard();
      currentRow = 1;
      currentGuess = "CRANE";
      refreshCurrentRow();
      submitGuess();
    })()`);
    await sleep(REVEAL_WAIT_MS);
    const realLoss = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      loseOpen: loseModal.classList.contains("is-open"),
      loseText: document.querySelector("#lose-modal-text")?.textContent.trim()
    }))()`);
    assert(realLoss.modalOpen === true, "Last-row real loss did not open a modal");
    assert(realLoss.loseOpen === true, "Last-row real loss did not open lose modal");
    assert(realLoss.loseText === "The word was ALERT.", `Unexpected real-loss text: ${realLoss.loseText}`);
    await session.evaluate(`loseNewGameButton.click()`);
    await sleep(150);

    await resetToKnownDictionary(session, [
      { word: "ALERT", definition: "" },
      { word: "ANGLE", definition: "" },
      { word: "CRANE", definition: "" },
    ], "ALERT");
    const pendingGuessCount = await session.evaluate(`currentMaxGuesses === 7 ? 6 : 7`);
    await session.evaluate(`(() => {
      currentGuess = "AB";
      refreshCurrentRow();
      settingsButton.click();
      guessCountSelect.value = "${pendingGuessCount}";
      guessCountSelect.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    const inProgressSettings = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      confirmOpen: confirmModal.classList.contains("is-open"),
      currentGuess,
      selectValue: guessCountSelect.value,
      currentMaxGuesses
    }))()`);
    assert(inProgressSettings.modalOpen === true, "In-progress settings change did not open confirmation");
    assert(inProgressSettings.confirmOpen === true, "Confirm modal is not visibly open for in-progress settings change");
    assert(inProgressSettings.currentGuess === "AB", `In-progress settings change lost guess: ${inProgressSettings.currentGuess}`);
    assert(
      inProgressSettings.selectValue === String(inProgressSettings.currentMaxGuesses),
      `Guess selector should revert before confirm, got ${inProgressSettings.selectValue}`,
    );
    await session.evaluate(`confirmCancelButton.click()`);
    await sleep(100);
    const afterCancel = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      currentGuess
    }))()`);
    assert(afterCancel.modalOpen === false, "Confirm cancel did not close modal");
    assert(afterCancel.currentGuess === "AB", `Confirm cancel should preserve guess, got ${afterCancel.currentGuess}`);

    const nonRepeatingWords = await session.evaluate(`(() => {
      answerWords = ["ALERT", "ANGLE"];
      validGuessSet = new Set(answerWords);
      document.cookie = "wordle_played_words=" + encodeURIComponent(JSON.stringify([])) + "; path=/; SameSite=Lax";
      const first = pickNextWord();
      const second = pickNextWord();
      return { first, second };
    })()`);
    assert(
      nonRepeatingWords.first !== nonRepeatingWords.second,
      `Expected pickNextWord to avoid repeats until exhaustion, got ${nonRepeatingWords.first} then ${nonRepeatingWords.second}`,
    );

    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
    ], "CRANE");
    await session.evaluate(`(() => {
      currentGuess = "NOSHY";
      refreshCurrentRow();
      submitGuess();
    })()`);
    const errorScreenState = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      errorOpen: errorScreen.classList.contains("is-open"),
      title: document.querySelector("#error-screen-title")?.textContent.trim(),
      text: document.querySelector("#error-screen-text")?.textContent.trim(),
      button: document.querySelector("#error-screen-reload-button")?.textContent.trim()
    }))()`);
    assert(errorScreenState.modalOpen === true, "NOSHY did not open the blocking error screen");
    assert(errorScreenState.errorOpen === true, "Error screen is not visibly open");
    assert(errorScreenState.title === "Unable to load words.", `Unexpected error screen title: ${errorScreenState.title}`);
    assert(errorScreenState.text === "Please reload the page.", `Unexpected error screen text: ${errorScreenState.text}`);
    assert(errorScreenState.button === "Reload", `Unexpected error screen button text: ${errorScreenState.button}`);

    console.log("Browser comprehensive test passed.");
  } finally {
    session.close();
  }
}

function terminate(child, signal = "SIGINT") {
  if (!child || child.killed) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill(signal);
    setTimeout(() => {
      if (!child.killed) {
        child.kill("SIGKILL");
      }
    }, 2_000);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const cwd = path.resolve(__dirname, "..");
  const appUrl = `http://${HOST}:${options.serverPort}/`;
  const remoteBaseUrl = `http://${HOST}:${options.debugPort}`;
  const chromeProfileDir = await fs.mkdtemp(path.join(os.tmpdir(), "shydle-chrome-profile-"));

  const server = spawnLoggedProcess(
    options.python,
    ["-u", "-m", "http.server", String(options.serverPort), "--bind", HOST],
    { cwd },
  );
  const chrome = spawnLoggedProcess(options.chrome, [
    "--headless=new",
    `--remote-debugging-port=${options.debugPort}`,
    `--user-data-dir=${chromeProfileDir}`,
    "about:blank",
  ]);

  try {
    await waitForOutput(server, /Serving HTTP on/, SERVER_START_TIMEOUT_MS, "HTTP server");
    await waitForOutput(chrome, /DevTools listening on/, CHROME_START_TIMEOUT_MS, "Chrome");
    await runComprehensiveChecks(appUrl, remoteBaseUrl);
  } finally {
    await terminate(server);
    await terminate(chrome);
    await fs.rm(chromeProfileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
