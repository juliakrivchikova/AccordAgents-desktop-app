.DEFAULT_GOAL := help

.PHONY: help install dev start build build-main typecheck clean

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; print "Available targets:"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install Node dependencies
	npm install

dev: ## Run the Electron app in development mode
	npm run dev

start: ## Build and run the Electron app
	npm start

build: ## Build the app
	npm run build

build-main: ## Build the Electron main process
	npm run build:main

typecheck: ## Run TypeScript checks
	npm run typecheck

clean: ## Remove build output
	rm -rf dist
