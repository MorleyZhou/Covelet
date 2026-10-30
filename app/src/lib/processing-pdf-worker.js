// Fixed packaged entry. The build adapter removes all network/remote loaders
// from PDF.js; this worker consumes only transferred PDF byte arrays.
import 'pdfjs-dist/build/pdf.worker.mjs';
