"use client";

import { useRef, useState } from "react";
import { browserClient } from "@/lib/supabase/client";

/**
 * The poster, however you happen to have it.
 *
 * "Copy image" puts the picture itself on the clipboard, not its address, so
 * pasting that into a plain text box did nothing. This field takes either: paste
 * an address and it is used as-is; paste or choose an image file and it is
 * uploaded to the posters bucket and the resulting public URL is used instead.
 */
export default function PosterField({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(file: File) {
    setError("");
    if (!file.type.startsWith("image/")) {
      setError("That is not an image.");
      return;
    }
    if (file.size > 5_000_000) {
      setError("That image is over 5 MB. Use a smaller one, or paste its address instead.");
      return;
    }

    setBusy(true);
    const extension = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
    const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
    const supabase = browserClient();

    const { error: uploadError } = await supabase.storage
      .from("posters")
      .upload(path, file, { contentType: file.type, upsert: false });

    if (uploadError) {
      setError(`${uploadError.message} - has migration 011 been run?`);
      setBusy(false);
      return;
    }
    const { data } = supabase.storage.from("posters").getPublicUrl(path);
    onChange(data.publicUrl);
    setBusy(false);
  }

  function onPaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const image = Array.from(event.clipboardData.items).find((item) =>
      item.type.startsWith("image/"),
    );
    if (!image) return; // a pasted address falls through to the normal input
    event.preventDefault();
    const file = image.getAsFile();
    if (file) upload(file);
  }

  return (
    <div className="posterfield">
      <div className="posterrow">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          placeholder="Paste the image itself, or its address"
          disabled={busy}
        />
        <button
          type="button"
          className="minibtn"
          onClick={() => fileInput.current?.click()}
          disabled={busy}
        >
          {busy ? "Uploading..." : "Choose file"}
        </button>
        {value && (
          <button type="button" className="minibtn" onClick={() => onChange("")} disabled={busy}>
            Clear
          </button>
        )}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload(file);
          e.target.value = "";
        }}
      />

      <p className="hint">
        Copy the poster (right-click &rarr; Copy image) and press Ctrl+V here, or choose a file.
        An image address works too.
      </p>
      {error && <p className="hint errortext">{error}</p>}
      {value && (
        // eslint-disable-next-line @next/next/no-img-element
        <img className="draftposter" src={value} alt="Poster preview" />
      )}
    </div>
  );
}
