/**
 * Clickable "open" captions under transcript images.
 *
 * Terminal graphics are painted over cells, so an image placement cannot carry
 * an OSC 8 link itself. A one-line caption below it links to a typed blob file
 * (`<blobs>/<sha256>.<ext>`) that the OS image viewer opens at full size.
 */
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Text } from "../components/text";
import { type ImageBlobWriterSync, materializeImageReferenceLinksSync } from "../prompt/image-references";
import { fileHyperlink, isHyperlinkEnabled } from "../render/hyperlink";
import { getImageDimensions } from "../terminal-capabilities";
import { imagePayloadKey } from "./image-loading";

/** Distinct images whose blob path is remembered, so re-renders never re-hash or re-write. */
const MAX_REMEMBERED_LINKS = 512;

let writeBlob: ImageBlobWriterSync | undefined;
const links = new Map<string, string | undefined>();

/** Install (or clear) the host's content-addressed blob writer that backs caption links. */
export function setTranscriptImageLinkWriter(writer: ImageBlobWriterSync | undefined): void {
	writeBlob = writer;
	links.clear();
}

/**
 * Caption linking `image` to a file on disk, or `undefined` when the terminal
 * shows no hyperlinks or no host writer is installed.
 */
export function imageOpenCaption(image: ImageContent, color: (text: string) => string): Text | undefined {
	if (!writeBlob || !isHyperlinkEnabled() || !image.data) return undefined;
	const key = imagePayloadKey(image);
	let target = links.get(key);
	if (target === undefined && !links.has(key)) {
		target = materializeImageReferenceLinksSync([image], writeBlob)?.[0];
		if (links.size >= MAX_REMEMBERED_LINKS) links.delete(links.keys().next().value!);
		links.set(key, target);
	}
	if (!target) return undefined;
	const dims = getImageDimensions(image.data, image.mimeType);
	const format = image.mimeType.replace(/^image\//u, "");
	const label = `↗ open ${dims ? `${dims.widthPx}×${dims.heightPx} ` : ""}${format}`;
	return new Text(fileHyperlink(target, color(label)), 1, 0);
}
