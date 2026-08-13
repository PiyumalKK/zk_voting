import { ButtonSpinner } from "./ButtonSpinner";
import { render, screen } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * The regression net for the daisyUI 5 `loading` migration.
 *
 * Five buttons in this app carried `${busy ? "loading" : ""}` — the v3/v4 idiom
 * for "prepend a spinner". In v5 `loading` is a standalone component that masks
 * its own element into the spinner, so on a `.btn` it deleted the background
 * and the label instead of decorating them. The failure is invisible in review
 * (the class name still reads like a loading state) and invisible at rest (the
 * button is only broken while a transaction is in flight), which is why the
 * source guard below matters more than the render cases above it.
 */

const PACKAGE_ROOT = path.resolve(__dirname, "..");
const SCANNED_DIRS = ["app", "components"];

describe("ButtonSpinner", () => {
  it("keeps the slot mounted at one width whether or not it is pending", () => {
    const { container: idle } = render(<ButtonSpinner pending={false} />);
    const idleSlot = idle.firstElementChild!;
    const idleClass = idleSlot.getAttribute("class");

    const { container: busy } = render(<ButtonSpinner pending />);
    const busySlot = busy.firstElementChild!;

    // Same element, same classes, in both states: the label beside it cannot
    // move when the spinner comes and goes.
    expect(idleSlot.tagName).toBe(busySlot.tagName);
    expect(busySlot.getAttribute("class")).toBe(idleClass);
    expect(idleClass).toContain("w-4");
  });

  it("shows a spinner only while pending", () => {
    const { container: idle } = render(<ButtonSpinner pending={false} />);
    expect(idle.querySelector(".loading-spinner")).toBeNull();

    const { container: busy } = render(<ButtonSpinner pending />);
    expect(busy.querySelector(".loading-spinner")).not.toBeNull();
  });

  it("reuses the spinner size the rest of the app uses inside buttons", () => {
    // `loading-xs` is what SaveButton renders; a second size would make the
    // same action look different from one screen to the next.
    const { container } = render(<ButtonSpinner pending />);
    expect(container.querySelector(".loading.loading-spinner.loading-xs")).not.toBeNull();
  });

  it("hides the slot from assistive technology", () => {
    // The pending state is announced by the button's label and `aria-busy`.
    // A second, wordless node in the accessibility tree adds nothing.
    const { container } = render(<ButtonSpinner pending />);
    expect(container.firstElementChild!.getAttribute("aria-hidden")).toBe("true");
  });

  it("leaves a button's label readable while pending", () => {
    render(
      <button className="btn btn-primary" disabled aria-busy>
        <ButtonSpinner pending />
        Adding to Blockchain...
      </button>,
    );

    const button = screen.getByRole("button", { name: /adding to blockchain/i });
    // The class list is the whole point: `loading` on the button itself is what
    // masked the label away.
    expect(button.className.split(/\s+/)).not.toContain("loading");
    expect(button.querySelector(".loading-spinner")).not.toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

/**
 * Strips comments before matching, so the explanation of the bug in
 * `ButtonSpinner.tsx` does not read as the bug.
 */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const listSourceFiles = (dir: string): string[] => {
  const absolute = path.join(PACKAGE_ROOT, dir);
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx$/.test(entry)) {
        out.push(path.relative(PACKAGE_ROOT, full).split(path.sep).join("/"));
      }
    }
  };
  walk(absolute);
  return out;
};

const sourceFiles = SCANNED_DIRS.flatMap(listSourceFiles);

/** Every `className` value in a file — quoted attributes and `{\`…\`}` templates alike. */
const classNameValues = (source: string): string[] =>
  Array.from(source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)).map(m => m[1] ?? m[2]);

/**
 * A `className` that names both `btn` and a bare `loading` is the v3 idiom.
 *
 * `loading-spinner`, `loading-xs` and friends are fine anywhere — the offender
 * is the standalone `loading` component class landing on a button.
 */
const isStaleButtonLoading = (value: string): boolean =>
  /\bbtn\b/.test(value) && /(^|[\s"'`{])loading(?![-\w])/.test(value);

describe("no daisyUI v3 button spinners", () => {
  it("finds source files to scan at all", () => {
    // Guards against the scan passing because the walk found nothing.
    expect(sourceFiles.length).toBeGreaterThan(20);
  });

  it("never puts the standalone `loading` class on a button", () => {
    const offenders = sourceFiles.flatMap(file => {
      const source = stripComments(readFileSync(path.join(PACKAGE_ROOT, file), "utf8"));
      return classNameValues(source)
        .filter(isStaleButtonLoading)
        .map(value => `${file}: ${value.trim()}`);
    });

    expect(offenders).toEqual([]);
  });

  it("recognises the idiom it is looking for", () => {
    // Without this the test above would pass just as happily on a broken regex.
    expect(isStaleButtonLoading('btn btn-primary w-full ${isSubmitting ? "loading" : ""}')).toBe(true);
    expect(isStaleButtonLoading("btn btn-primary loading")).toBe(true);
    expect(isStaleButtonLoading("btn btn-primary")).toBe(false);
    expect(isStaleButtonLoading("loading loading-spinner loading-xs")).toBe(false);
    expect(isStaleButtonLoading("btn btn-ghost btn-square")).toBe(false);
  });
});
