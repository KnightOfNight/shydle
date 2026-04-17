"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const HOST = "127.0.0.1";
const SERVER_PORT = 8123;
const DEBUG_PORT = 9222;
const APP_URL = `http://${HOST}:${SERVER_PORT}/`;
const REMOTE_BASE_URL = `http://${HOST}:${DEBUG_PORT}`;
const SERVER_START_TIMEOUT_MS = 10_000;
const CHROME_START_TIMEOUT_MS = 15_000;
const PAGE_LOAD_WAIT_MS = 2_500;
const INITIALIZE_TIMEOUT_MS = 20_000;
const REVEAL_WAIT_MS = 1_050;

function parseArgs(argv) {
  const options = {
    python: "python3",
    chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
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

async function createDevToolsSession(targetUrl) {
  const targetResponse = await fetch(
    `${REMOTE_BASE_URL}/json/new?${encodeURIComponent(targetUrl)}`,
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
    const entries = ${entriesJson};
    categories = { general: entries.map((entry) => entry.word) };
    refreshCategoryPools();
    currentCategory = "all";
    applyCategory(currentCategory, { fallbackToDefault: true });
    document.cookie = "wordle_played_words=" + encodeURIComponent(JSON.stringify({ all: [] })) + "; path=/; SameSite=Lax";
    return resetGame().then(() => {
      if (${secretValue} !== null) {
        secretWord = ${secretValue};
      }
    });
  })()`);
}

async function runComprehensiveChecks() {
  const session = await createDevToolsSession(APP_URL);

  try {
    await waitForReady(session);

    const initial = await session.evaluate(`(() => ({
      title: document.querySelector(".app-title")?.textContent.trim(),
      rows: document.querySelectorAll(".board-row").length,
      message: document.querySelector("#message")?.textContent.trim(),
      dictionaryReady,
      currentMaxGuesses,
      currentCategory,
      modalOpen: isModalOpen
    }))()`);
    assert(initial.title === "SHYDLE", `Unexpected title: ${initial.title}`);
    assert(initial.rows === initial.currentMaxGuesses, "Board rows do not match currentMaxGuesses on load");
    assert(initial.dictionaryReady === true, "Dictionary is not ready after initialization");
    assert(initial.message === "", `Expected empty message box on load, got ${initial.message}`);
    assert(initial.currentCategory === "all", `Expected default category all, got ${initial.currentCategory}`);
    assert(initial.modalOpen === false, "Modal should not be open on initial load");

    await session.evaluate(`settingsButton.click()`);
    const settingsOpen = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      settingsOpen: settingsModal.classList.contains("is-open"),
      activeId: document.activeElement?.id,
      categoryValue: categorySelect.value
    }))()`);
    assert(settingsOpen.modalOpen === true, "Settings button did not open the modal");
    assert(settingsOpen.settingsOpen === true, "Settings modal is not visibly open");
    assert(settingsOpen.activeId === "settings-close-button", `Expected Close Settings to be focused, got ${settingsOpen.activeId}`);
    assert(settingsOpen.categoryValue === "all", `Expected all selected in settings, got ${settingsOpen.categoryValue}`);

    await session.evaluate(`(() => {
      settingsCloseButton.click();
      settingsButton.click();
      categorySelect.value = "science";
      categorySelect.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await sleep(150);
    const categoryApplied = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      currentCategory,
      categoryValue: categorySelect.value,
      localValue: localStorage.getItem("wordle_category"),
      cookie: document.cookie
    }))()`);
    assert(categoryApplied.modalOpen === false, "Settings modal should close after immediate category change");
    assert(categoryApplied.currentCategory === "science", `Expected science category, got ${categoryApplied.currentCategory}`);
    assert(categoryApplied.categoryValue === "science", `Expected science selector value, got ${categoryApplied.categoryValue}`);
    assert(categoryApplied.localValue === "science", `Expected stored category science, got ${categoryApplied.localValue}`);
    assert(categoryApplied.cookie.includes("wordle_category=science"), `Category cookie did not persist science: ${categoryApplied.cookie}`);

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
      setInlineMessage();
      handleKeyPress("ENTER");
    })()`);
    const shortEnterIgnored = await session.evaluate(`(() => ({
      currentGuess,
      currentRow,
      message: document.querySelector("#message")?.textContent.trim()
    }))()`);
    assert(shortEnterIgnored.currentGuess === "AB", `Short ENTER mutated currentGuess: ${shortEnterIgnored.currentGuess}`);
    assert(shortEnterIgnored.currentRow === 0, `Short ENTER advanced row unexpectedly: ${shortEnterIgnored.currentRow}`);
    assert(shortEnterIgnored.message === "", `Short ENTER should not write a message, got ${shortEnterIgnored.message}`);

    await session.evaluate(`(() => {
      currentGuess = "";
      refreshCurrentRow();
      handleHintRequest();
    })()`);
    const firstRowHint = await session.evaluate(`(() => ({
      html: document.querySelector("#message")?.innerHTML.trim(),
      text: document.querySelector("#message")?.textContent.trim()
    }))()`);
    assert(
      firstRowHint.html === "<em>Type a 5 letter word to get started.</em>",
      `Unexpected first-row hint html: ${firstRowHint.html}`,
    );
    assert(firstRowHint.text === "Type a 5 letter word to get started.", `Unexpected first-row hint text: ${firstRowHint.text}`);

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
    const clearedAfterAdvance = await session.evaluate(`(() => ({
      currentRow,
      message: document.querySelector("#message")?.textContent.trim()
    }))()`);
    assert(clearedAfterAdvance.currentRow === 1, `Expected move to row 1, got ${clearedAfterAdvance.currentRow}`);
    assert(clearedAfterAdvance.message === "", `Expected message to clear after leaving first row, got ${clearedAfterAdvance.message}`);

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
      setInlineMessage();
      handleHintRequest();
    })()`);
    const hintedWordStillUsesLetterHint = await session.evaluate(`(() => ({
      html: document.querySelector("#message")?.innerHTML.trim(),
      text: document.querySelector("#message")?.textContent.trim(),
      correctKeys: Array.from(document.querySelectorAll(".key.correct")).map((key) => key.dataset.key),
      revealedHintCount: revealedHintIndices.length
    }))()`);
    assert(
      /^<em>The word contains an "[A-Z]"\.<\/em>$/.test(hintedWordStillUsesLetterHint.html),
      `Unexpected hint html for defined word: ${hintedWordStillUsesLetterHint.html}`,
    );
    assert(
      /^The word contains an "[A-Z]"\.$/.test(hintedWordStillUsesLetterHint.text),
      `Unexpected hint text for defined word: ${hintedWordStillUsesLetterHint.text}`,
    );
    assert(
      hintedWordStillUsesLetterHint.correctKeys.length === 1,
      `Expected one green keyboard key for defined-word hint, got ${hintedWordStillUsesLetterHint.correctKeys.length}`,
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
      setInlineMessage();
      handleHintRequest();
    })()`);
    const freeLetterHint = await session.evaluate(`(() => ({
      html: document.querySelector("#message")?.innerHTML.trim(),
      text: document.querySelector("#message")?.textContent.trim(),
      correctKeys: Array.from(document.querySelectorAll(".key.correct")).map((key) => key.dataset.key),
      revealedHintCount: revealedHintIndices.length
    }))()`);
    assert(
      /^<em>The word contains an "[A-Z]"\.<\/em>$/.test(freeLetterHint.html),
      `Unexpected free-letter hint html: ${freeLetterHint.html}`,
    );
    assert(
      /^The word contains an "[A-Z]"\.$/.test(freeLetterHint.text),
      `Unexpected free-letter hint text: ${freeLetterHint.text}`,
    );
    assert(freeLetterHint.correctKeys.length === 1, `Expected one green keyboard key from free-letter hint, got ${freeLetterHint.correctKeys.length}`);
    assert(freeLetterHint.revealedHintCount === 1, `Expected one recorded free-letter hint, got ${freeLetterHint.revealedHintCount}`);

    await session.evaluate(`(() => {
      keyStates.clear();
      [["C", "correct"], ["R", "correct"], ["A", "correct"], ["N", "present"]]
        .forEach(([letter, state]) => keyStates.set(letter, state));
      setInlineMessage();
      handleHintRequest();
    })()`);
    const noMoreFreeLetters = await session.evaluate(`document.querySelector("#message")?.innerHTML.trim()`);
    assert(
      noMoreFreeLetters === "<em>You only need one more letter!</em>",
      `Unexpected no-more-free-letters message: ${noMoreFreeLetters}`,
    );

    await resetToKnownDictionary(session, [
      { word: "CRANE", definition: "" },
    ], "CRANE");
    await session.evaluate(`(() => {
      setInlineMessage();
      currentGuess = "QQQQQ";
      refreshCurrentRow();
      submitGuess();
    })()`);
    const invalidGuess = await session.evaluate(`(() => ({
      html: document.querySelector("#message")?.innerHTML.trim(),
      currentRow,
      currentGuess
    }))()`);
    assert(
      invalidGuess.html === "<em>QQQQQ</em> is not in the dictionary.",
      `Unexpected invalid-guess html: ${invalidGuess.html}`,
    );
    assert(invalidGuess.currentRow === 0, `Invalid guess advanced row unexpectedly: ${invalidGuess.currentRow}`);
    assert(invalidGuess.currentGuess === "QQQQQ", `Invalid guess should leave the guess in place, got ${invalidGuess.currentGuess}`);

    await session.evaluate(`(() => {
      currentGuess = "DESHY";
      refreshCurrentRow();
      submitGuess();
    })()`);
    const testMessage = await session.evaluate(`(() => ({
      text: document.querySelector("#message")?.textContent.trim(),
      currentRow,
      currentGuess
    }))()`);
    assert(
      testMessage.text === "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.",
      `Unexpected DESHY message text: ${testMessage.text}`,
    );
    assert(testMessage.currentRow === 0, `DESHY should not advance row, got ${testMessage.currentRow}`);
    assert(testMessage.currentGuess === "DESHY", `DESHY should leave currentGuess in place, got ${testMessage.currentGuess}`);

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
      categories = {
        general: ["ALERT"],
        science: ["ANGLE", "ATOMS"]
      };
      refreshCategoryPools();
      currentCategory = "science";
      applyCategory(currentCategory, { fallbackToDefault: true });
      document.cookie = "wordle_played_words=" + encodeURIComponent(JSON.stringify({ science: [] })) + "; path=/; SameSite=Lax";
      const first = pickNextWord();
      const second = pickNextWord();
      return { first, second };
    })()`);
    assert(
      nonRepeatingWords.first !== nonRepeatingWords.second,
      `Expected pickNextWord to avoid repeats until exhaustion, got ${nonRepeatingWords.first} then ${nonRepeatingWords.second}`,
    );

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
  const chromeProfileDir = await fs.mkdtemp(path.join(os.tmpdir(), "shydle-chrome-profile-"));

  const server = spawnLoggedProcess(
    options.python,
    ["-u", "-m", "http.server", String(SERVER_PORT), "--bind", HOST],
    { cwd },
  );
  const chrome = spawnLoggedProcess(options.chrome, [
    "--headless=new",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${chromeProfileDir}`,
    "about:blank",
  ]);

  try {
    await waitForOutput(server, /Serving HTTP on/, SERVER_START_TIMEOUT_MS, "HTTP server");
    await waitForOutput(chrome, /DevTools listening on/, CHROME_START_TIMEOUT_MS, "Chrome");
    await runComprehensiveChecks();
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
