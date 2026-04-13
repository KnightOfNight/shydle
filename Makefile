.PHONY: test-browser

NODE ?= /opt/homebrew/bin/node
PYTHON ?= python3
CHROME ?= /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome

test-browser:
	$(NODE) scripts/browser-smoke-test.js --python $(PYTHON) --chrome $(CHROME)
