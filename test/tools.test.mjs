// Unit tests for tool helpers. Run after `npm run build`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withModel } from "../dist/tools.js";

const providers = (models, error) => ({ providers: { listModels: async () => ({ models, error }) } });

test("withModel keeps provider/model and resolves a bare provider to its default model", async () => {
  assert.equal(await withModel(providers([]), "claude/claude-opus-5-5"), "claude/claude-opus-5-5");
  const models = [{ id: "a" }, { id: "b", isDefault: true }];
  assert.equal(await withModel(providers(models), "claude"), "claude/b");
  assert.equal(await withModel(providers([{ id: "only" }]), "echo"), "echo/only");
  await assert.rejects(withModel(providers([], "not installed"), "codex"), /lists no models \(not installed\)/);
});
