/**
 * Image uploads are typed from their bytes.
 *
 * multer's fileFilter only checks the Content-Type the client declares, so a
 * non-image labelled image/png used to reach R2, where multer-s3's
 * AUTO_CONTENT_TYPE stored it under whatever it sniffed (image/svg+xml
 * included). Now only real JPEG/PNG/WebP files are stored, always under their
 * image type, and anything else is a 400.
 */
process.env.R2_ACCOUNT_ID = "test-account";
process.env.R2_ACCESS_KEY_ID = "test-key-id";
process.env.R2_SECRET_ACCESS_KEY = "test-secret";
process.env.R2_BUCKET_NAME = "test-bucket";
delete process.env.USE_LOCAL_UPLOADS;

const { Readable } = require("stream");
const express = require("express");

const r2Client = require("../config/r2");
const upload = require("../config/multer");
const r2Upload = require("../config/multerR2");
const errorHandler = require("../middlewares/errorHandler");
const { detectImageMime, verifiedImageContentType } = require("../utils/imageContentType");

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("rest-of-a-png-file"),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("rest-of-a-jpeg-file")]);
const WEBP = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from("WEBPVP8 rest-of-a-webp-file"),
]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
const NOT_AN_IMAGE_MESSAGE = "Only JPG, PNG, and WebP images are allowed";

describe("detectImageMime", () => {
  test("recognises JPEG, PNG and WebP by signature, and nothing else", () => {
    expect(detectImageMime(JPEG)).toBe("image/jpeg");
    expect(detectImageMime(PNG)).toBe("image/png");
    expect(detectImageMime(WEBP)).toBe("image/webp");
    expect(detectImageMime(SVG)).toBeNull();
    expect(detectImageMime(Buffer.from("GIF89a-rest-of-file"))).toBeNull();
    expect(detectImageMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("verifiedImageContentType", () => {
  // Runs the multer-s3 contentType hook over a stream of `chunks` and reads
  // back the body it hands to the upload.
  const run = (chunks) =>
    new Promise((resolve) => {
      const stream = Readable.from(chunks);
      verifiedImageContentType({}, { stream }, async (err, mime, body) => {
        if (err) return resolve({ err });
        const parts = [];
        for await (const part of body) parts.push(part);
        resolve({ mime, data: Buffer.concat(parts) });
      });
    });

  test("types the file from its bytes and passes every byte through", async () => {
    const { mime, data } = await run([PNG.subarray(0, 2), PNG.subarray(2, 5), PNG.subarray(5)]);
    expect(mime).toBe("image/png");
    expect(data.equals(PNG)).toBe(true);
  });

  test("a file that ends inside the signature window still completes", async () => {
    const tiny = JPEG.subarray(0, 5);
    const { mime, data } = await run([tiny]);
    expect(mime).toBe("image/jpeg");
    expect(data.equals(tiny)).toBe(true);
  });

  test("anything else is a client error", async () => {
    for (const chunks of [[SVG], [Buffer.alloc(0)]]) {
      const { err } = await run(chunks);
      expect(err.statusCode).toBe(400);
      expect(err.message).toBe(NOT_AN_IMAGE_MESSAGE);
    }
  });
});

describe("upload routes on R2 storage", () => {
  let server;
  let baseUrl;
  let stored;

  beforeAll(async () => {
    // Stand-in for R2: record what would be stored instead of sending it.
    r2Client.send = async (command) => {
      stored.push(command.input);
      return { ETag: '"stub"' };
    };

    const app = express();
    const reply = (req, res) => res.json({ contentType: req.file.contentType });
    app.post("/upload", upload.single("image"), reply);
    app.post("/kyc", r2Upload.single("selfie"), reply);
    app.use(errorHandler);
    server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  beforeEach(() => {
    stored = [];
  });

  afterAll(() => new Promise((resolve) => server.close(resolve)));

  const post = async (path, field, bytes, declaredType) => {
    const form = new FormData();
    form.append(field, new Blob([bytes], { type: declaredType }), "photo.png");
    const res = await fetch(baseUrl + path, { method: "POST", body: form });
    return { status: res.status, body: await res.json() };
  };

  test("a real PNG is stored as image/png with its bytes intact", async () => {
    const res = await post("/upload", "image", PNG, "image/png");

    expect(res.status).toBe(200);
    expect(res.body.contentType).toBe("image/png");
    expect(stored).toHaveLength(1);
    expect(stored[0].ContentType).toBe("image/png");
    expect(Buffer.from(stored[0].Body).equals(PNG)).toBe(true);
  });

  test("the stored type follows the bytes, not the declared type", async () => {
    const res = await post("/kyc", "selfie", JPEG, "image/png");

    expect(res.status).toBe(200);
    expect(stored[0].ContentType).toBe("image/jpeg");
  });

  test("a non-image declared as an image is rejected and never stored", async () => {
    for (const [path, field] of [
      ["/upload", "image"],
      ["/kyc", "selfie"],
    ]) {
      const res = await post(path, field, SVG, "image/png");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(NOT_AN_IMAGE_MESSAGE);
    }
    expect(stored).toHaveLength(0);
  });
});
