// PageImage — the PageEditor's image node. Extends @tiptap/extension-image with
// three extra attributes so the editor can mirror Plane's upload UX:
//   • uploadId  — a transient id used to locate the node and swap its `src` once
//                 the real upload resolves (data-upload-id in the DOM).
//   • uploading — true while the S3 upload is in flight; drives the pulse/loading
//                 skeleton CSS in PageEditor.svelte (data-uploading in the DOM).
//   • width     — persisted explicit width (kept for forward-compat with resize).
// allowBase64 is enabled so the local/dev data-URL fallback (presign 503 / S3 off)
// renders inline exactly like the chat composer's attachment fallback.
import Image from "@tiptap/extension-image";

export const PageImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el) => el.getAttribute("width"),
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
      uploadId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-upload-id"),
        renderHTML: (attrs) => (attrs.uploadId ? { "data-upload-id": attrs.uploadId } : {}),
      },
      uploading: {
        default: false,
        // Transient: never re-hydrate a stale "uploading" flag from saved content.
        parseHTML: () => false,
        renderHTML: (attrs) => (attrs.uploading ? { "data-uploading": "true" } : {}),
      },
    };
  },
}).configure({ inline: false, allowBase64: true });
