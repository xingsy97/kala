import { useEffect, useRef } from 'react'
import * as monaco from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import typescriptWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// Keep the editor and every language worker in the versioned Dashboard bundle.
// The previous React adapter silently fell back to a public CDN and could leave
// file preview on its own `Loading...` screen forever when that CDN was blocked.
globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new typescriptWorker()
    return new editorWorker()
  },
}

type EditorProps = {
  value?: string
  language?: string
  theme?: string
  options?: monaco.editor.IStandaloneEditorConstructionOptions
  onMount?: (editor: monaco.editor.IStandaloneCodeEditor, api: typeof monaco) => void
}

export function Editor({ value = '', language = 'plaintext', theme = 'vs-dark', options, onMount }: EditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor>()
  const modelRef = useRef<monaco.editor.ITextModel>()

  useEffect(() => {
    if (!containerRef.current) return
    const model = monaco.editor.createModel(value, language)
    const editor = monaco.editor.create(containerRef.current, { model, theme, automaticLayout: true, ...options })
    modelRef.current = model
    editorRef.current = editor
    onMount?.(editor, monaco)
    return () => {
      editor.dispose()
      model.dispose()
      editorRef.current = undefined
      modelRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const model = modelRef.current
    if (model && model.getValue() !== value) model.setValue(value)
  }, [value])
  useEffect(() => {
    const model = modelRef.current
    if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
  }, [language])
  useEffect(() => { monaco.editor.setTheme(theme) }, [theme])
  useEffect(() => { if (options) editorRef.current?.updateOptions(options) }, [options])

  return <div className="h-full w-full" data-testid="monaco-editor" ref={containerRef} />
}

type DiffEditorProps = {
  original?: string
  modified?: string
  language?: string
  theme?: string
  options?: monaco.editor.IStandaloneDiffEditorConstructionOptions
}

export function DiffEditor({ original = '', modified = '', language = 'plaintext', theme = 'vs-dark', options }: DiffEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor>()
  const originalModelRef = useRef<monaco.editor.ITextModel>()
  const modifiedModelRef = useRef<monaco.editor.ITextModel>()

  useEffect(() => {
    if (!containerRef.current) return
    const originalModel = monaco.editor.createModel(original, language)
    const modifiedModel = monaco.editor.createModel(modified, language)
    const editor = monaco.editor.createDiffEditor(containerRef.current, { theme, automaticLayout: true, ...options })
    editor.setModel({ original: originalModel, modified: modifiedModel })
    originalModelRef.current = originalModel
    modifiedModelRef.current = modifiedModel
    editorRef.current = editor
    return () => {
      editor.dispose()
      originalModel.dispose()
      modifiedModel.dispose()
      editorRef.current = undefined
      originalModelRef.current = undefined
      modifiedModelRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const model = originalModelRef.current
    if (model && model.getValue() !== original) model.setValue(original)
  }, [original])
  useEffect(() => {
    const model = modifiedModelRef.current
    if (model && model.getValue() !== modified) model.setValue(modified)
  }, [modified])
  useEffect(() => {
    for (const model of [originalModelRef.current, modifiedModelRef.current]) {
      if (model && model.getLanguageId() !== language) monaco.editor.setModelLanguage(model, language)
    }
  }, [language])
  useEffect(() => { monaco.editor.setTheme(theme) }, [theme])
  useEffect(() => { if (options) editorRef.current?.updateOptions(options) }, [options])

  return <div className="h-full w-full" data-testid="monaco-diff-editor" ref={containerRef} />
}

export default Editor
