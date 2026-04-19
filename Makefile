.PHONY: test-browser test-browser-comprehensive test-all webpage

NODE ?= /opt/homebrew/bin/node
PYTHON ?= python3
CHROME ?= /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
SMOKE_SERVER_PORT ?= 8123
SMOKE_DEBUG_PORT ?= 9222
COMPREHENSIVE_SERVER_PORT ?= 8124
COMPREHENSIVE_DEBUG_PORT ?= 9223
WORDS_COUNT ?= 10000
WEBPAGE_SOURCES = index.html.in script.js styles.css new.json

test-browser:
	$(NODE) scripts/browser-smoke-test.js --python $(PYTHON) --chrome $(CHROME) --server-port $(SMOKE_SERVER_PORT) --debug-port $(SMOKE_DEBUG_PORT)

test-browser-comprehensive:
	$(NODE) scripts/browser-comprehensive-test.js --python $(PYTHON) --chrome $(CHROME) --server-port $(COMPREHENSIVE_SERVER_PORT) --debug-port $(COMPREHENSIVE_DEBUG_PORT)

test-all: test-browser test-browser-comprehensive

webpage:
	@VERSION=$$(cat $(WEBPAGE_SOURCES) | shasum -a 256 | awk '{print $$1}' | cut -c1-12); \
	TIMESTAMP=$$(date -u +"%Y-%m-%dT%H:%M:%SZ"); \
	sed -e "s/__WEBPAGE_VERSION__/$$VERSION/g" -e "s/__WEBPAGE_TIMESTAMP__/$$TIMESTAMP/g" index.html.in > index.html; \
	echo "Rendered index.html with version $$VERSION at $$TIMESTAMP"
