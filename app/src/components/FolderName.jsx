import { tr, getLocale } from "../i18n/index.js";
import { useEffect, useId, useRef, useState } from "react";
import { Input } from './ui/input.jsx';

/** An inline folder title. The caller owns persistence and conflict checks. */
export default function FolderName({ name, onSave }) {
  const inputRef = useRef(null);
  const latestName = useRef(name);
  const originalName = useRef(name);
  const draftRef = useRef(name);
  const editing = useRef(false);
  const saving = useRef(false);
  const skipBlur = useRef(false);
  const composing = useRef(false);
  const [draft, setDraft] = useState(name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const errorId = useId();
  latestName.current = name;

  useEffect(() => {
    if (editing.current) return;
    draftRef.current = name;
    originalName.current = name;
    setDraft(name);
  }, [name]);

  function replaceDraft(value) {
    draftRef.current = value;
    setDraft(value);
  }

  function leaveFocus() {
    if (document.activeElement !== inputRef.current) return;
    skipBlur.current = true;
    inputRef.current.blur();
  }

  async function save() {
    if (saving.current || composing.current) return;
    const value = draftRef.current.trim();
    if (!value || /[\u0000-\u001f\u007f]/u.test(draftRef.current)) {
      setError(!value ? tr("名称不能为空。") : tr("名称不能包含控制字符。"));
      return;
    }
    if (value.length > 200) {
      setError(tr("名称最多 200 个字符。"));
      return;
    }
    if (value === latestName.current) {
      replaceDraft(value);
      setError("");
      editing.current = false;
      leaveFocus();
      return;
    }
    saving.current = true;
    setPending(true);
    setError("");
    try {
      // Keep the focus-time baseline even when a concurrent update rerenders us.
      const saved = await onSave(value, originalName.current);
      if (saved !== true) {
        setError(tr("未能保存，请重试。"));
        return;
      }
      replaceDraft(value);
      editing.current = false;
      leaveFocus();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : tr("未能保存，请重试。"));
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <div className="folder-name-editor">
      <Input unstyled
        ref={inputRef}
        className="folder-name-input"
        aria-label={tr("文件夹名称")}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-busy={pending || undefined}
        value={draft}
        maxLength={200}
        readOnly={pending}
        autoComplete="off"
        onFocus={(event) => {
          if (!editing.current) originalName.current = latestName.current;
          editing.current = true;
          event.currentTarget.select();
        }}
        onChange={(event) => {
          replaceDraft(event.target.value);
          setError("");
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          replaceDraft(event.currentTarget.value);
          // Some input methods finish composition after the field has blurred.
          if (document.activeElement !== inputRef.current) void save();
        }}
        onBlur={() => {
          if (skipBlur.current) { skipBlur.current = false; return; }
          void save();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (composing.current || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) {
              event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            // A write already in progress belongs to the caller and cannot be canceled here.
            if (saving.current) return;
            composing.current = false;
            replaceDraft(latestName.current);
            setError("");
            editing.current = false;
            leaveFocus();
            return;
          }
          if (event.key !== "Enter" || composing.current || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229) return;
          event.preventDefault();
          event.stopPropagation();
          void save();
        }}
      />
      {error && <span id={errorId} className="folder-name-error" role="alert">{tr(error)}</span>}
    </div>
  );
}
