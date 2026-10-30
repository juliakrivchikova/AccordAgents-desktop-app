// pdf.js ships no types for its worker bundle. The file panel imports it to run
// the worker's code on the page (no separate worker URL in the packaged app).
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
