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
const RACE_WAIT_MS = 900;

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
      continue;
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

async function runSmokeChecks() {
  const session = await createDevToolsSession(APP_URL);

  try {
    await sleep(PAGE_LOAD_WAIT_MS);

    const initializationStart = Date.now();
    while (true) {
      const ready = await session.evaluate(
        `typeof dictionaryReady !== "undefined" ? dictionaryReady : false`,
      );
      if (ready) {
        break;
      }

      if (Date.now() - initializationStart > INITIALIZE_TIMEOUT_MS) {
        throw new Error("Dictionary did not finish initializing");
      }

      await sleep(250);
    }

    const initial = await session.evaluate(`(() => ({
      title: document.querySelector(".app-title")?.textContent,
      rows: document.querySelectorAll(".board-row").length,
      message: document.querySelector("#message")?.textContent.trim(),
      dictionaryReady: typeof dictionaryReady !== "undefined" ? dictionaryReady : null,
      currentMaxGuesses
    }))()`);
    assert(initial.title === "SHYDLE", `Unexpected title: ${initial.title}`);
    assert(
      initial.rows === initial.currentMaxGuesses,
      `Expected initial board rows to match currentMaxGuesses (${initial.currentMaxGuesses}), got ${initial.rows}`,
    );
    assert(initial.dictionaryReady === true, "Dictionary did not finish initializing");

    await session.evaluate(`(() => {
      handleKeyPress("A");
      handleKeyPress("B");
    })()`);
    await session.evaluate(`handleStartNewGame()`);

    const partialResetCheck = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      guess: currentGuess,
      modalTitle: document.querySelector("#confirm-modal-title")?.textContent.trim()
    }))()`);
    assert(partialResetCheck.modalOpen === true, "Partial guess did not trigger reset confirmation");
    assert(partialResetCheck.guess === "AB", `Expected partial guess to survive until confirmation, got ${partialResetCheck.guess}`);
    assert(partialResetCheck.modalTitle === "Start new game?", `Unexpected modal title: ${partialResetCheck.modalTitle}`);
    await session.evaluate(`confirmCancelButton.click()`);

    await session.evaluate(`(() => {
      guessCountSelect.value = currentMaxGuesses === 7 ? "5" : "7";
      guessCountSelect.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    const guessCountCheck = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      selectValue: guessCountSelect.value,
      currentMaxGuesses,
      guess: currentGuess,
      pendingTarget: currentMaxGuesses === 7 ? 5 : 7
    }))()`);
    assert(guessCountCheck.modalOpen === true, "Guess-count change did not trigger confirmation");
    assert(
      guessCountCheck.selectValue === String(guessCountCheck.currentMaxGuesses),
      `Guess selector should revert until confirmation, got ${guessCountCheck.selectValue}`,
    );
    assert(guessCountCheck.guess === "AB", `Guess-count change lost in-progress guess before confirm: ${guessCountCheck.guess}`);

    await session.evaluate(`confirmAcceptButton.click()`);
    await sleep(200);
    const afterGuessCountConfirm = await session.evaluate(`(() => ({
      rows: document.querySelectorAll(".board-row").length,
      currentMaxGuesses,
      guess: currentGuess,
      currentRow
    }))()`);
    assert(
      afterGuessCountConfirm.rows === guessCountCheck.pendingTarget,
      `Expected ${guessCountCheck.pendingTarget} rows after confirmation, got ${afterGuessCountConfirm.rows}`,
    );
    assert(
      afterGuessCountConfirm.currentMaxGuesses === guessCountCheck.pendingTarget,
      `Expected guess count ${guessCountCheck.pendingTarget} after confirmation, got ${afterGuessCountConfirm.currentMaxGuesses}`,
    );
    assert(afterGuessCountConfirm.guess === "", `Expected cleared guess after reset, got ${afterGuessCountConfirm.guess}`);
    assert(afterGuessCountConfirm.currentRow === 0, `Expected currentRow reset to 0, got ${afterGuessCountConfirm.currentRow}`);

    await session.evaluate(`(() => {
      resetGame();
      currentGuess = "AB";
      refreshCurrentRow();
      window.__abandonedWord = secretWord;
      handleStartNewGame();
    })()`);
    const revealConfirmCheck = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      confirmTitle: document.querySelector("#confirm-modal-title")?.textContent.trim(),
      guess: currentGuess
    }))()`);
    assert(revealConfirmCheck.modalOpen === true, "Start-new-game confirmation did not open for in-progress game");
    assert(revealConfirmCheck.confirmTitle === "Start new game?", `Unexpected confirmation title: ${revealConfirmCheck.confirmTitle}`);
    await session.evaluate(`confirmAcceptButton.click()`);
    await sleep(100);
    const revealModalCheck = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      revealOpen: document.querySelector("#reveal-modal")?.classList.contains("is-open"),
      revealTitle: document.querySelector("#reveal-modal-title")?.textContent.trim(),
      revealText: document.querySelector("#reveal-modal-text")?.textContent.trim(),
      guess: currentGuess
    }))()`);
    assert(revealModalCheck.modalOpen === true, "Reveal modal did not open after confirming abandonment");
    assert(revealModalCheck.revealOpen === true, "Reveal modal is not visibly open");
    assert(revealModalCheck.revealTitle === "The word was...", `Unexpected reveal title: ${revealModalCheck.revealTitle}`);
    assert(
      revealModalCheck.revealText === `The word was ${await session.evaluate(`window.__abandonedWord`)}.`,
      `Unexpected reveal text: ${revealModalCheck.revealText}`,
    );
    assert(revealModalCheck.guess === "AB", `Expected in-progress guess to remain until reveal acknowledgement, got ${revealModalCheck.guess}`);
    await session.evaluate(`revealOkButton.click()`);
    await sleep(150);
    const revealResetCheck = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      currentGuess,
      currentRow
    }))()`);
    assert(revealResetCheck.modalOpen === false, "Reveal modal did not close after acknowledgement");
    assert(revealResetCheck.currentGuess === "", `Expected cleared guess after reveal acknowledgement, got ${revealResetCheck.currentGuess}`);
    assert(revealResetCheck.currentRow === 0, `Expected currentRow reset after reveal acknowledgement, got ${revealResetCheck.currentRow}`);

    await session.evaluate(`(() => {
      currentGuess = "ABCDE";
      refreshCurrentRow();
      const original = window.isAllowedGuess;
      window.__raceSeen = null;
      window.isAllowedGuess = async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return true;
      };
      submitGuess();
      setTimeout(() => resetGame(), 50);
      setTimeout(() => {
        window.__raceSeen = {
          currentRow,
          currentGuess,
          revealedTiles: document.querySelectorAll(".tile.revealed").length,
          gameOver,
          isCheckingGuess
        };
        window.isAllowedGuess = original;
      }, 700);
    })()`);
    await sleep(RACE_WAIT_MS);
    const raceCheck = await session.evaluate(`window.__raceSeen`);
    assert(raceCheck.currentRow === 0, `Race check advanced currentRow unexpectedly: ${raceCheck.currentRow}`);
    assert(raceCheck.currentGuess === "", `Race check left stale currentGuess: ${raceCheck.currentGuess}`);
    assert(raceCheck.revealedTiles === 0, `Race check revealed ${raceCheck.revealedTiles} tiles after reset`);
    assert(raceCheck.gameOver === false, "Race check ended the game unexpectedly");
    assert(raceCheck.isCheckingGuess === false, "Race check left guess validation stuck");

    await session.evaluate(`(() => {
      const forcedWord = dictionary[0];
      secretWord = forcedWord;
      currentGuess = forcedWord;
      refreshCurrentRow();
      submitGuess();
    })()`);
    await sleep(RACE_WAIT_MS);
    const solvedState = await session.evaluate(`(() => ({
      gameOver,
      modalOpen: isModalOpen,
      winOpen: document.querySelector("#win-modal")?.classList.contains("is-open"),
      winTitle: document.querySelector("#win-modal-title")?.textContent.trim(),
      winText: document.querySelector("#win-modal-text")?.textContent.trim()
    }))()`);
    assert(solvedState.gameOver === true, "Expected forced solve flow to end the game");
    assert(solvedState.modalOpen === true, "Expected solved game to open the win modal");
    assert(solvedState.winOpen === true, "Win modal is not visibly open after solving");
    assert(solvedState.winTitle === "YOU WIN!", `Unexpected win modal title: ${solvedState.winTitle}`);
    assert(
      solvedState.winText === `The word was ${await session.evaluate(`secretWord`)}.`,
      `Unexpected win modal text: ${solvedState.winText}`,
    );

    await session.evaluate(`winNewGameButton.click()`);
    await sleep(250);
    await session.evaluate(`(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "C", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "R", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "A", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "N", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "E", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()`);
    await sleep(200);
    const postSolveResetCheck = await session.evaluate(`(() => ({
      modalOpen: isModalOpen,
      currentGuess,
      currentRow
    }))()`);
    assert(postSolveResetCheck.modalOpen === false, "Enter reopened a modal after a solved-game reset");
    assert(postSolveResetCheck.currentRow === 1, `Expected submitted guess to advance to row 1, got ${postSolveResetCheck.currentRow}`);
    assert(postSolveResetCheck.currentGuess === "", `Expected guess to submit cleanly after reset, got ${postSolveResetCheck.currentGuess}`);

    console.log("Browser smoke test passed.");
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
  const chromeProfileDir = await fs.mkdtemp(path.join(os.tmpdir(), "wordle-chrome-profile-"));

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
    await runSmokeChecks();
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
