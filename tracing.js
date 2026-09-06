// model-router/tracing.js
//
// OpenTelemetry export (roadmap step 36.2). Builds on the request-scoped
// `trace_id` that server.js generates (step 36.1): that id is set as a span
// attribute so a trace in an OTel backend and a metrics.js row for the same
// request can be cross-referenced by the same value even though they are two
// different systems.
//
// Gated off by default (OTEL_ENABLED). The @opentelemetry/api no-op tracer
// is always present (it is the API surface and costs nothing when the SDK is
// not initialized), but the heavy SDK + exporter are lazily required and only
// started when BOTH OTEL_ENABLED=true AND OTEL_EXPORTER_OTLP_ENDPOINT is set -
// "never initializes at all" when unused, not "initializes and exports
// nowhere". Spans here are MANUAL ONLY: auto-instrumentation is explicitly out
// of scope (spec 220), so no registerInstrumentations() call.

const { trace, context } = require('@opentelemetry/api');

const TRACER_NAME = 'cachegate';

let initialized = false;

/**
 * Initialize the OTel SDK exactly once. A no-op unless both gates are open.
 * Any SDK failure is logged and swallowed (fail-open): tracing must never be
 * the reason a real request fails.
 */
function initTracing() {
  if (initialized) return;
  initialized = true;
  if (process.env.OTEL_ENABLED !== 'true') return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;
  try {
    // Lazy-require the SDK + exporter only on the enabled path, so a
    // deployment that never opts in never loads them.
    const { NodeSDK } = require('@opentelemetry/sdk-node');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
    const sdk = new NodeSDK({
      traceExporter: new OTLPTraceExporter({ url: endpoint })
      // No instrumentations: manual spans only (spec 220, out of scope).
    });
    sdk.start();
    process.on('SIGTERM', () => {
      sdk.shutdown().finally(() => process.exit(0));
    });
  } catch (err) {
    console.warn('⚠️ OTel SDK failed to initialize, tracing disabled:', err.message);
  }
}

/**
 * Start a span as a child of whatever span is currently active. With a no-op
 * tracer (SDK off) this is a no-op object whose methods are all safe no-ops.
 */
function startSpan(name, attributes = {}) {
  return trace.getTracer(TRACER_NAME).startSpan(name, { attributes });
}

/**
 * Run `fn` inside a span named `name`, ending it when `fn` settles. The span
 * is a child of the active span (the request's root span, set via
 * withRootSpan). Does NOT make the new span itself active - none of the
 * wrapped operations start their own nested spans, so there is nothing to
 * nest. Re-throws on failure after recording the exception on the span.
 */
async function withSpan(name, attributes, fn) {
  const span = startSpan(name, attributes);
  try {
    return await fn();
  } catch (err) {
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Run `fn` inside a NEW root span (the one span per request), making it the
 * active context so every `withSpan`/`startSpan` inside nests under it.
 * `trace_id` is carried as a span attribute so this trace can be joined to
 * metrics rows for the same request.
 */
async function withRootSpan(name, attributes, fn) {
  const span = startSpan(name, attributes);
  try {
    return await context.with(trace.setSpan(context.active(), span), fn);
  } catch (err) {
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
}

module.exports = { initTracing, startSpan, withSpan, withRootSpan };
