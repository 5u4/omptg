import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: false });

/** Sync render markdown → sanitized HTML for v-html style binding. */
export function md(src: string): string {
	const raw = marked.parse(src ?? "", { async: false }) as string;
	return DOMPurify.sanitize(raw);
}
