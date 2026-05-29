// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Discover Legal
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, version 3.
// See <https://www.gnu.org/licenses/gpl-3.0.html>

import { AnthropicProvider } from "./anthropic.js";
import { OllamaProvider } from "./ollama.js";
import type { ModelProvider } from "./types.js";

export * from "./types.js";

export const OLLAMA_PREFIX = "ollama:";

/** True if this model ID targets a local Ollama instance. */
export function isOllamaModel(modelId: string): boolean {
  return modelId.startsWith(OLLAMA_PREFIX);
}

/** Strip the "ollama:" prefix to get the bare Ollama model name. */
export function ollamaModelName(modelId: string): string {
  return modelId.slice(OLLAMA_PREFIX.length);
}

// Lazily-created singletons — one client per provider type
let _anthropic: AnthropicProvider | undefined;
let _ollama: OllamaProvider | undefined;

/** Return the correct provider for a model ID. */
export function getProvider(modelId: string): ModelProvider {
  if (isOllamaModel(modelId)) {
    _ollama ??= new OllamaProvider();
    return _ollama;
  }
  _anthropic ??= new AnthropicProvider();
  return _anthropic;
}

/** Resolve the bare model name to pass to the provider's chat() call. */
export function resolveModelId(modelId: string): string {
  return isOllamaModel(modelId) ? ollamaModelName(modelId) : modelId;
}
