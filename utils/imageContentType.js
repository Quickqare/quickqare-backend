const { PassThrough } = require("stream");

// Content-Type for stored uploads, taken from the file's own leading bytes
// (its format signature), never from the client.
//
// multer's fileFilter only sees the Content-Type the client declared for the
// part, so any file can pass it labelled image/png. multer-s3's
// AUTO_CONTENT_TYPE then stored whatever it sniffed from the bytes — including
// image/svg+xml, a type browsers run scripts in. Now only real JPEG, PNG and
// WebP files are accepted, and they are always stored under that image type.

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 12; // the longest signature checked below (WebP)

function detectImageMime(head) {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return "image/jpeg";
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return "image/png";
  }
  if (
    head.length >= 12 &&
    head.toString("latin1", 0, 4) === "RIFF" &&
    head.toString("latin1", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

// multer-s3 `contentType` option. Buffers the first bytes, checks them, and
// hands multer-s3 a stream that replays those bytes followed by the rest.
function verifiedImageContentType(_req, file, cb) {
  const source = file.stream;
  const chunks = [];
  let received = 0;
  let settled = false;

  const detach = () => {
    source.removeListener("data", onData);
    source.removeListener("end", onEnd);
    source.removeListener("error", onError);
  };

  const finish = (ended) => {
    if (settled) return;
    settled = true;
    detach();

    const head = Buffer.concat(chunks);
    const mime = detectImageMime(head);
    if (!mime) {
      source.resume(); // discard the rest so the request can complete
      const err = new Error("Only JPG, PNG, and WebP images are allowed");
      err.statusCode = 400;
      return cb(err);
    }

    const body = new PassThrough();
    if (ended) {
      body.end(head);
    } else {
      // Attached synchronously inside the data handler, so no chunk is missed.
      body.write(head);
      source.pipe(body);
    }
    cb(null, mime, body);
  };

  function onData(chunk) {
    chunks.push(chunk);
    received += chunk.length;
    if (received >= HEADER_BYTES) finish(false);
  }
  function onEnd() {
    finish(true);
  }
  function onError(err) {
    if (settled) return;
    settled = true;
    detach();
    cb(err);
  }

  source.on("data", onData);
  source.on("end", onEnd);
  source.on("error", onError);
}

module.exports = { detectImageMime, verifiedImageContentType };
