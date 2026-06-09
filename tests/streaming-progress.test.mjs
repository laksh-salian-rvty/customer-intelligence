import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile("src/streamingProgress.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
});

const progress = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`);

test("initial progress is available before any network bytes arrive", () => {
  const status = progress.createInitialStreamStatus("Predict cancellation probability for recent orders", 1_000);

  assert.deepEqual(status.agents, ["Order Cancellation Prediction"]);
  assert.equal(status.steps.length, 1);
  assert.equal(status.steps[0].label, "Analyzing request");
  assert.equal(status.steps[0].startedAt, 1_000);
  assert.equal(status.steps[0].endedAt, undefined);
});

test("optimistic route and query steps advance the live thinking state without server events", () => {
  const status = progress.createInitialStreamStatus("Predict cancellation probability for recent orders", 1_000);
  const routed = progress.appendStreamStep(
    status.steps,
    "client-route",
    "Selecting specialist",
    progress.routingDetail(status.agents),
    1_000 + progress.OPTIMISTIC_ROUTE_DELAY_MS,
    "system",
  );
  const querying = progress.appendStreamStep(
    routed,
    "client-query",
    progress.firstAgentLabel(status.agents),
    progress.firstAgentDetail(status.agents[0]),
    1_000 + progress.OPTIMISTIC_QUERY_DELAY_MS,
    "query",
  );

  assert.equal(querying.length, 3);
  assert.equal(querying[0].endedAt, 1_700);
  assert.equal(querying[1].label, "Selecting specialist");
  assert.equal(querying[1].endedAt, 2_600);
  assert.equal(querying[2].label, "Querying Order Cancellation Prediction");
  assert.equal(querying[2].kind, "query");
  assert.equal(querying[2].endedAt, undefined);
});

test("broad requests still show a specialist instead of generic starting analysis", () => {
  const status = progress.createInitialStreamStatus("Give me a complete 360 customer summary", 5_000);

  assert.ok(status.agents.length > 1);
  assert.equal(progress.firstAgentLabel(status.agents), "Querying Customer Churn Analytics");
});
