.PHONY: test-browser test-browser-comprehensive webpage

NODE ?= /opt/homebrew/bin/node
PYTHON ?= python3
CHROME ?= /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
WORDS_COUNT ?= 10000
WEBPAGE_SOURCES = index.html.in script.js styles.css new.json

test-browser:
	$(NODE) scripts/browser-smoke-test.js --python $(PYTHON) --chrome $(CHROME)

test-browser-comprehensive:
	$(NODE) scripts/browser-comprehensive-test.js --python $(PYTHON) --chrome $(CHROME)

webpage:
	@VERSION=$$(cat $(WEBPAGE_SOURCES) | shasum -a 256 | awk '{print $$1}' | cut -c1-12); \
	sed "s/__WEBPAGE_VERSION__/$$VERSION/g" index.html.in > index.html; \
	echo "Rendered index.html with version $$VERSION"
