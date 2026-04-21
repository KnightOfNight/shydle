.PHONY: test-browser-smoke test-browser-comprehensive test-all webpage container container-local-files k8s-apply k8s-restart deploy deploy-local

NODE ?= /opt/homebrew/bin/node
PYTHON ?= python3
CHROME ?= /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
SMOKE_SERVER_PORT ?= 8123
SMOKE_DEBUG_PORT ?= 9222
COMPREHENSIVE_SERVER_PORT ?= 8124
COMPREHENSIVE_DEBUG_PORT ?= 9223
WORDS_COUNT ?= 10000
IMAGE ?= shydle
TAG := $(shell date +%s)
K8S_CONTAINERD_ADDRESS ?= /var/run/docker/containerd/containerd.sock
WEBPAGE_SOURCES = index.html.in script.js styles.css words.json
WEBPAGE_VERSION := $(shell cat $(WEBPAGE_SOURCES) | shasum -a 256 | awk '{print $$1}' | cut -c1-12)
WEBPAGE_TIMESTAMP := $(shell date -u +"%Y-%m-%dT%H:%M:%SZ")

test-browser-smoke:
	$(NODE) tests/browser-smoke-test.js --python $(PYTHON) --chrome $(CHROME) --server-port $(SMOKE_SERVER_PORT) --debug-port $(SMOKE_DEBUG_PORT)

test-browser-comprehensive:
	$(NODE) tests/browser-comprehensive-test.js --python $(PYTHON) --chrome $(CHROME) --server-port $(COMPREHENSIVE_SERVER_PORT) --debug-port $(COMPREHENSIVE_DEBUG_PORT)

test-all: test-browser-smoke test-browser-comprehensive

webpage:
	sed -e "s/__WEBPAGE_VERSION__/$(WEBPAGE_VERSION)/g" -e "s/__WEBPAGE_TIMESTAMP__/$(WEBPAGE_TIMESTAMP)/g" index.html.in > index.html
	echo "Rendered index.html with version $(WEBPAGE_VERSION) at $(WEBPAGE_TIMESTAMP)"

container:
	docker build --no-cache --pull -t $(IMAGE):$(TAG) .

container-local-files:
	docker build --no-cache --pull -f Dockerfile.local -t $(IMAGE):$(TAG) .
#	docker save $(IMAGE):$(TAG) | nerdctl --address $(K8S_CONTAINERD_ADDRESS) -n k8s.io load

k8s-apply:
	sed "s/\$${IMAGE_TAG}/$(TAG)/g" k8s/deployment.yaml | kubectl apply -f -
	kubectl apply -f k8s/service.yaml

k8s-restart:
	kubectl rollout restart deployment/$(IMAGE)

deploy-local: container-local-files k8s-apply k8s-restart

deploy: container k8s-apply k8s-restart
