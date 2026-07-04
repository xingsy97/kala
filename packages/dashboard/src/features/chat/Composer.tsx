import { useState, type FormEvent } from 'react'

type Props = {
  disabled?: boolean
  onSubmit(text: string): void
}

export function Composer({ disabled, onSubmit }: Props): JSX.Element {
  const [text, setText] = useState('')

  function handleSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    onSubmit(trimmed)
    setText('')
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t border-slate-800 p-3 flex gap-2"
    >
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        disabled={disabled}
        placeholder={
          disabled ? 'waiting for host - ' : 'type a message and press Enter'
        }
        className="flex-1 bg-slate-900 border border-slate-700 rounded p-2 text-sm text-slate-100 resize-none focus:outline-none focus:border-slate-500 disabled:opacity-50"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            const trimmed = text.trim()
            if (trimmed.length === 0) return
            onSubmit(trimmed)
            setText('')
          }
        }}
      />
      <button
        type="submit"
        disabled={disabled}
        className="px-3 py-2 bg-slate-100 text-slate-900 rounded font-medium hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Send
      </button>
    </form>
  )
}
