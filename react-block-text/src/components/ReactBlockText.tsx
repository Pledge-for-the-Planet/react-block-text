// TODO
// x Rewrite for plugins
// - Handle copy/paste
// - Handle undo/redo
// x Handle drag/drop of multiple blocks
// x Handle scroll selection
// x Write header plugin
// x Write quote plugin
// x Write list plugin
// x Complete list plugin (it's buggy)
// - Write code plugin
// - Write image plugin
// - Write table plugin (may need to set editorStates as an array)
// - Create inline menu and handle styling and block conversion
// - Write color plugin (meta plugin)
// - Handle block conversion on block menu
// - Fix / and backspace bug
// x Handle text conversion
// - AI plugin (meta plugin)
// x Separate package from app
// x Publish to npm
// x Fix multiline enter bug
// x Remove convertibleToTextTypes
// x Add isNextItemOfSameType to plugin API
// x Host demo
// x Add CI for demo hosting
// x Write documentation
// - Write demo default editor text
// - Investigate Checkbox opacity transition
// x Handle meta backspace bug
// x Handle rect selection + dnd bug on non-selected indented blocks
// x Fix arrow up/down bug on long text
// x Fix long text selection offset
// x Fix selection rect bg bug
// x Remove indent on text, header, ...
// x Take icons into paddingLeft account
// x Fix block menu position
// x Fix arrow + selection bug
// x Fix arrow up on empty line bug
// - Rename API plugins to blockPlugins
// x Fix multiline arrowdown bug on trimmed lines
// x Display block menu on new block created
// - Fix mutliple blocks drag issue (when dragging not from the first block selected)
// - Make "- " work with the list plugin
// - Fix single empty block placeholder
// - Fix click on MenuQueryItem bug

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { nanoid } from 'nanoid'
import { DndProvider } from 'react-dnd'
import { HTML5Backend } from 'react-dnd-html5-backend'
import {
  ContentBlock,
  ContentState,
  Editor,
  EditorState,
  Modifier,
  SelectionState,
  convertFromRaw,
  convertToRaw,
} from 'draft-js'
import 'draft-js/dist/Draft.css'
import Color from 'color'
// @ts-expect-error
import ignoreWarnings from 'ignore-warnings'
import _ from 'clsx'

import type {
  ArrowData,
  BlockCommonProps,
  BlockContentProps,
  BlockProps,
  DragData,
  EditorRefRegistry,
  QueryMenuData,
  ReactBlockTextDataItem,
  ReactBlockTextDataItemType,
  ReactBlockTextEditorStates,
  ReactBlockTextPluginOptions,
  ReactBlockTextProps,
  SelectionRectData,
  SelectionTextData,
  XY,
} from '../types'

import {
  ADD_ITEM_BUTTON_ID,
  BASE_SCROLL_SPEED,
  COMMANDS,
  DEFAULT_PRIMARY_COLOR,
  DEFAULT_TEXT_COLOR,
  DRAG_ITEM_BUTTON_ID,
  SELECTION_RECT_SCROLL_OFFSET,
  VERSION,
} from '../constants'

import textPlugin from '../plugins/text'

import ColorsContext from '../contexts/ColorsContext'

import usePrevious from '../hooks/usePrevious'

import appendItemData from '../utils/appendItemData'
import countCharactersOnLastBlockLines from '../utils/countCharactersOnLastBlockLines'
import findAttributeInParents from '../utils/findAttributeInParents'
import findParentWithId from '../utils/findParentWithId'
import findScrollParent from '../utils/findScrollParent'
import findSelectionRectIds from '../utils/findSelectionRectIds'
import forceContentFocus from '../utils/forceContentFocus'
import getQueryMenuData from '../utils/getQueryMenuData'
import getFirstLineFocusOffset from '../utils/getFirstLineFocusOffset'
import getLastLineFocusOffset from '../utils/getLastLineFocusOffset'
import getRelativeMousePosition from '../utils/getRelativeMousePosition'

import Block from './Block'
import BlockContentText from './BlockContentText'
import QueryMenu from './QueryMenu'
import SelectionRect from './SelectionRect'
import DragLayer from './DragLayer'

declare const window: Window & typeof globalThis & {
  __isReactDndBackendSetUp: boolean
}

// Remove onUpArrow and onDownArrow deprecation warnings
ignoreWarnings([
  'Supplying an `onUpArrow`',
  'Supplying an `onDownArrow`',
])

// Not a state to avoid infinite render loops
// instanceId -> itemId -> editorRef
const editorRefs: Record<string, EditorRefRegistry> = {}
const selectionRefs: Record<string, Record<string, HTMLElement>> = {}

// Not a state for performance reasons
let isSelecting = false
let lastForceFocusTime = 0
let lastMousePosition: XY = { x: 0, y: 0 }
let scrollParentFrame = -1

function ReactBlockText({
  value: rawValue,
  onChange: rawOnChange,
  primaryColor: rawPrimaryColor,
  textColor: rawTextColor,
  className,
  style,
  plugins = [],
  readOnly,
  paddingTop,
  paddingBottom,
  paddingLeft,
  paddingRight,
  onSave,
}: ReactBlockTextProps) {
  const [editorStates, setEditorStates] = useState<ReactBlockTextEditorStates>({})

  /* ---
    VALUE PARSING
  --- */
  const value = useMemo<ReactBlockTextDataItem[]>(() => {
    try {
      const value = JSON.parse(rawValue || '')

      if (!Array.isArray(value)) return []

      // TODO check reactBlockTextVersion
      return value
    }
    catch (error) {
      return []
    }
  }, [rawValue])

  /* ---
    ONCHANGE VALUE STRINGIFICATION
  --- */
  const onChange = useCallback((nextValue: ReactBlockTextDataItem[]) => {
    rawOnChange?.(JSON.stringify(nextValue))
  }, [rawOnChange])

  /* ---
    COLORS
  --- */
  const primaryColor = useMemo(() => rawPrimaryColor || DEFAULT_PRIMARY_COLOR, [rawPrimaryColor])
  const primaryColorTransparent = useMemo(() => Color(primaryColor).alpha(0.15).hexa(), [primaryColor])
  const primaryColorDark = useMemo(() => Color(primaryColor).darken(0.1).hex(), [primaryColor])
  const textColor = useMemo(() => rawTextColor || DEFAULT_TEXT_COLOR, [rawTextColor])
  const colorsContextValue = useMemo(() => ({
    primaryColor,
    primaryColorTransparent,
    primaryColorDark,
    textColor,
  }), [
    primaryColor,
    primaryColorTransparent,
    primaryColorDark,
    textColor,
  ])

  /*
    ██████╗ ██╗     ██╗   ██╗ ██████╗ ██╗███╗   ██╗███████╗
    ██╔══██╗██║     ██║   ██║██╔════╝ ██║████╗  ██║██╔════╝
    ██████╔╝██║     ██║   ██║██║  ███╗██║██╔██╗ ██║███████╗
    ██╔═══╝ ██║     ██║   ██║██║   ██║██║██║╚██╗██║╚════██║
    ██║     ███████╗╚██████╔╝╚██████╔╝██║██║ ╚████║███████║
    ╚═╝     ╚══════╝ ╚═════╝  ╚═════╝ ╚═╝╚═╝  ╚═══╝╚══════╝
  */

  /* ---
    HANDLE PLUGIN CHANGE
  --- */
  const handlePluginChange = useCallback((item: ReactBlockTextDataItem, editorState: EditorState) => {
    if (readOnly) return
    if (!(item && editorState)) return

    const index = value.findIndex(x => x.id === item?.id)

    if (index === -1) return

    setEditorStates(x => ({ ...x, [item.id]: editorState }))

    const nextValue = [...value]

    nextValue[index] = item

    onChange(nextValue)
  }, [readOnly, value, onChange])

  /* ---
    PLUGINS MERGING
  --- */
  const pluginsData = useMemo(() => {
    const options: ReactBlockTextPluginOptions = {
      onChange: handlePluginChange,
    }

    return [
      ...textPlugin(),
      ...plugins,
    ]
    .map(x => x(options))
  }, [plugins, handlePluginChange])

  /* ---
    APPLY STYLES
  --- */
  const applyStyles = useCallback((item: ReactBlockTextDataItem, editorState: EditorState) => {
    const plugin = pluginsData.find(x => x.type === item.type)

    return plugin?.applyStyles?.(item, editorState) ?? editorState
  }, [pluginsData])

  /* ---
    APPLY METADATA
  --- */
  const applyMetadatas = useCallback((index: number, value: ReactBlockTextDataItem[], editorStates: ReactBlockTextEditorStates) => {
    let nextValue = [...value]

    pluginsData.forEach(plugin => {
      nextValue = plugin?.applyMetadatas?.(index, nextValue, editorStates) ?? nextValue
    })

    return nextValue
  }, [pluginsData])

  /*
    ███████╗████████╗ █████╗ ████████╗███████╗
    ██╔════╝╚══██╔══╝██╔══██╗╚══██╔══╝██╔════╝
    ███████╗   ██║   ███████║   ██║   █████╗
    ╚════██║   ██║   ██╔══██║   ██║   ██╔══╝
    ███████║   ██║   ██║  ██║   ██║   ███████╗
    ╚══════╝   ╚═╝   ╚═╝  ╚═╝   ╚═╝   ╚══════╝
  */

  const rootRef = useRef<HTMLDivElement>(null)
  const injectionRef = useRef<HTMLDivElement>(null)
  const [hoveredIndex, setHoveredIndex] = useState(-1)
  const [focusedIndex, setFocusedIndex] = useState(value.length ? -1 : 0)
  const [forceFocusIndex, setForceFocusIndex] = useState(-1)
  const [forceBlurIndex, setForceBlurIndex] = useState(-1)
  const [scrollIntoViewId, setScrollIntoViewId] = useState<string | null>(null)
  const [dragData, setDragData] = useState<DragData | null>(null)
  const [wasDragging, setWasDragging] = useState(false)
  const [isBlockMenuOpen, setIsBlockMenuOpen] = useState(false)
  const [isCaretVisible, setIsCaretVisible] = useState(true)
  const [arrowData, setArrowData] = useState<ArrowData | null>(null)
  const [queryMenuData, setQueryMenuData] = useState<QueryMenuData | null>(null)
  const [selectionRect, setSelectionRect] = useState<SelectionRectData | null>(null)
  const [selectionText, setSelectionText] = useState<SelectionTextData | null>(null)
  const [scrollSpeed, setScrollSpeed] = useState(0)
  const [refresh, setRefresh] = useState(false)
  const [shouldTriggerRefresh, setShouldTriggerRefresh] = useState(false)
  const [shouldBlurAllContent, setShouldBlurAllContent] = useState(false)
  const [shouldDisplayQueryMenu, setShouldDisplayQueryMenu] = useState(false)

  const previousEditorStates = usePrevious(editorStates, refresh || shouldTriggerRefresh)

  // A unique instance id for the sake of keeping refs, so multiple instances can be used on the same page
  const instanceId = useMemo(() => nanoid(), [])

  /*
    ██╗   ██╗████████╗██╗██╗     ███████╗
    ██║   ██║╚══██╔══╝██║██║     ██╔════╝
    ██║   ██║   ██║   ██║██║     ███████╗
    ██║   ██║   ██║   ██║██║     ╚════██║
    ╚██████╔╝   ██║   ██║███████╗███████║
     ╚═════╝    ╚═╝   ╚═╝╚══════╝╚══════╝
  */

  /* ---
    GET SELECTION RECT INDEXES
  --- */
  const getSelectionRectIndexes = useCallback(() => {
    const selectedIds = selectionRect?.selectedIds ?? []

    return value.map((item, index) => ({ item, index }))
      .filter(({ item }) => selectedIds.includes(item.id))
      .map(({ index }) => index)
  }, [value, selectionRect])

  /* ---
    REGISTER REF
    We associate each editor with an id so that we can access it later
  --- */
  const registerRef = useCallback((id: string, ref: Editor | null) => {
    if (!ref) return
    if (!editorRefs[instanceId]) {
      editorRefs[instanceId] = {}
    }

    editorRefs[instanceId][id] = ref
  }, [instanceId])

  /* ---
    REGISTER SELECTION REF
    We associate each selection outline with an id so that we can access it later
  --- */
  const registerSelectionRef = useCallback((id: string, ref: HTMLElement) => {
    if (!ref) return
    if (!selectionRefs[instanceId]) {
      selectionRefs[instanceId] = {}
    }

    selectionRefs[instanceId][id] = ref
  }, [instanceId])

  /*
     ██████╗██╗  ██╗ █████╗ ███╗   ██╗ ██████╗ ███████╗
    ██╔════╝██║  ██║██╔══██╗████╗  ██║██╔════╝ ██╔════╝
    ██║     ███████║███████║██╔██╗ ██║██║  ███╗█████╗
    ██║     ██╔══██║██╔══██║██║╚██╗██║██║   ██║██╔══╝
    ╚██████╗██║  ██║██║  ██║██║ ╚████║╚██████╔╝███████╗
     ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
  */

  /* ---
    CREATE TEXT ITEM
  --- */
  const createTextItem = useCallback(() => {
    const editorState = EditorState.createEmpty()
    const item = appendItemData(
      {
        reactBlockTextVersion: VERSION,
        id: nanoid(),
        type: 'text',
        indent: 0,
      },
      editorState
    )

    return { editorState, item }
  }, [])

  /* ---
    ADD ITEM
    Add a text item to the editor
  --- */
  const handleAddItem = useCallback((index: number) => {
    const { editorState, item } = createTextItem()
    let nextValue = [...value]

    nextValue.splice(index + 1, 0, item)

    const nextEditorStates = { ...editorStates, [item.id]: editorState }

    nextValue = applyMetadatas(index + 1, nextValue, nextEditorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    setHoveredIndex(index + 1)
    setFocusedIndex(index + 1)
    setForceFocusIndex(index + 1)
    setScrollIntoViewId(item.id)
    setShouldDisplayQueryMenu(true)
  }, [value, editorStates, onChange, createTextItem, applyMetadatas])

  /* ---
    DELETE ITEM
  --- */
  const handleDeleteItem = useCallback((index: number) => {
    // Delete only item
    if (value.length === 1) {
      const itemId = value[0].id

      const { editorState, item } = createTextItem()

      // Prevent flickering due to key change
      item.id = itemId

      const nextEditorStates = { [item.id]: editorState }
      const nextValue = applyMetadatas(index, [item], nextEditorStates)

      onChange(nextValue)
      setEditorStates(nextEditorStates)

      return
    }

    // Delete any item
    let nextValue = [...value]
    const [item] = nextValue.splice(index, 1)
    const nextEditorStates = { ...editorStates }

    delete nextEditorStates[item.id]

    nextValue = applyMetadatas(index, nextValue, nextEditorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    setHoveredIndex(-1)
  }, [value, editorStates, onChange, createTextItem, applyMetadatas])

  /* ---
    DUPLICATE ITEM
  --- */
  const handleDuplicateItem = useCallback((index: number) => {
    const item = value[index]

    if (!item) return

    const editorState = editorStates[item.id]

    if (!editorState) return

    let nextValue = [...value]
    const nextItem = { ...item, id: nanoid() }

    nextValue.splice(index + 1, 0, nextItem)

    const nextEditorStates = { ...editorStates, [nextItem.id]: editorState }

    nextValue = applyMetadatas(index + 1, nextValue, nextEditorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    setHoveredIndex(index + 1)
    setFocusedIndex(index + 1)
  }, [value, editorStates, onChange, applyMetadatas])

  /* ---
    CHANGE
    Handle editor value change
  --- */
  const handleChange = useCallback((id: string, editorState: EditorState) => {
    const index = value.findIndex(x => x.id === id)

    if (index === -1) return

    const item = value[index]
    let data = JSON.stringify(convertToRaw(editorState.getCurrentContent()))

    if (data === item.data) {
      setEditorStates(x => ({ ...x, [id]: editorState }))

      return
    }

    const nextEditorState = applyStyles(item, editorState)
    const nextEditorStates = { ...editorStates, [id]: nextEditorState }

    setEditorStates(nextEditorStates)

    data = JSON.stringify(convertToRaw(nextEditorState.getCurrentContent()))

    if (data === item.data) return

    let nextValue = [...value]

    nextValue[index] = { ...nextValue[index], data }
    nextValue = applyMetadatas(index, nextValue, nextEditorStates)

    onChange(nextValue)

    const currentSelection = nextEditorState.getSelection()
    const block = nextEditorState.getCurrentContent().getBlockForKey(currentSelection.getStartKey())
    const text = block.getText()
    const words = text.split(' ')
    const lastWord = words.pop() || ''
    const lastWordIncludesCommand = lastWord.includes('/')
    const lastChar = lastWord.slice(-1)

    // Toggle context menu with `/` command
    if (!queryMenuData && lastChar === '/') {
      setQueryMenuData(getQueryMenuData(editorRefs[instanceId], id, rootRef.current!))

      return
    }

    if (queryMenuData && !lastWordIncludesCommand && !queryMenuData.noSlash) {
      setQueryMenuData(null)

      return
    }

    if (queryMenuData && (lastWordIncludesCommand || queryMenuData.noSlash)) {
      const query = lastWord.slice(lastWord.lastIndexOf('/') + 1)

      setQueryMenuData(x => x ? ({ ...x, query }) : null) // Due to side effects the ternary is mandatory here
    }

    if (queryMenuData && queryMenuData.noSlash && words.length > 0) {
      setQueryMenuData(null)
    }
  }, [value, editorStates, instanceId, queryMenuData, onChange, applyStyles, applyMetadatas])

  /*
     █████╗ ██████╗ ██████╗  ██████╗ ██╗    ██╗███████╗
    ██╔══██╗██╔══██╗██╔══██╗██╔═══██╗██║    ██║██╔════╝
    ███████║██████╔╝██████╔╝██║   ██║██║ █╗ ██║███████╗
    ██╔══██║██╔══██╗██╔══██╗██║   ██║██║███╗██║╚════██║
    ██║  ██║██║  ██║██║  ██║╚██████╔╝╚███╔███╔╝███████║
    ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝  ╚══╝╚══╝ ╚══════╝
  */

  /* ---
    UP ARROW
    Handle up arrow, to move between editor instances
    Although this causes a warning in the console (suppressed), I found it to be the only way to make it work
  --- */
  const handleUpArrow = useCallback((index: number, event: ReactKeyboardEvent) => {
    if (index === 0) return

    if (queryMenuData) {
      event.preventDefault()

      return
    }

    const editorState = editorStates[value[index]?.id]
    const previousEditorState = editorStates[value[index - 1]?.id]

    if (!(editorState && previousEditorState)) return

    const selection = editorState.getSelection()

    // If not on the first block, return
    if (editorState.getCurrentContent().getFirstBlock().getKey() !== selection.getFocusKey()) return
    // If under selection, return
    if (selection.getAnchorOffset() !== selection.getFocusOffset()) return

    setIsCaretVisible(false)

    // A timeout is necessary for the editorState to update the selection
    setTimeout(() => {
      setArrowData({
        index,
        isTop: true,
        offset: selection.getFocusOffset(),
      })
    })
  }, [value, editorStates, queryMenuData])

  /* ---
    DOWN ARROW
    Handle down arrow, to move between editor instances
    Although this causes a warning in the console (suppressed), I found it to be the only way to make it work
  --- */
  const handleDownArrow = useCallback((index: number, event: ReactKeyboardEvent) => {
    if (index === value.length - 1) return

    if (queryMenuData) {
      event.preventDefault()

      return
    }

    const item = value[index]

    if (!item) return

    const editorState = editorStates[item.id]
    const nextEditorState = editorStates[value[index + 1]?.id]

    if (!(editorState && nextEditorState)) return

    const selection = editorState.getSelection()

    // If not on the last block, return
    if (editorState.getCurrentContent().getLastBlock().getKey() !== selection.getFocusKey()) return
    // If under selection, return
    if (selection.getAnchorOffset() !== selection.getFocusOffset()) return

    setIsCaretVisible(false)

    // A timeout is necessary for the editorState to update the selection
    setTimeout(() => {
      setArrowData({
        index,
        isTop: false,
        offset: selection.getFocusOffset(),
      })
    })
  }, [value, editorStates, queryMenuData])

  const handleArrow = useCallback(() => {
    if (!arrowData) return

    setArrowData(null)
    setIsCaretVisible(true)

    const { index, isTop, offset } = arrowData
    const item = value[arrowData.index]

    if (!item) return

    const editorState = editorStates[item.id]

    if (!editorState) return

    const selection = editorState.getSelection()

    if (isTop) {
      const firstBlock = editorState.getCurrentContent().getFirstBlock()

      if (!(selection.getFocusKey() === firstBlock.getKey() && selection.getFocusOffset() === 0)) return

      const previousItem = value[index - 1]

      if (!previousItem) return

      const previousEditorState = editorStates[previousItem.id]

      if (!previousEditorState) return

      const previousLastBlock = previousEditorState.getCurrentContent().getLastBlock()
      const nextFocusOffset = Math.min(getFirstLineFocusOffset(
        previousItem.id,
        offset,
        editorRefs[instanceId][previousItem.id]?.editorContainer,
        injectionRef.current!
      ), previousLastBlock.getLength())
      const nextSelection = SelectionState.createEmpty(previousLastBlock.getKey()).merge({
        anchorOffset: nextFocusOffset,
        focusOffset: nextFocusOffset,
      })
      const updatedNextEditorState = EditorState.forceSelection(previousEditorState, nextSelection)

      setEditorStates(x => ({ ...x, [previousItem.id]: updatedNextEditorState }))
      setFocusedIndex(index - 1)
    }
    else {
      const lastBlock = editorState.getCurrentContent().getLastBlock()

      if (!(selection.getFocusKey() === lastBlock.getKey() && selection.getFocusOffset() === lastBlock.getLength())) return

      const nextItem = value[index + 1]

      if (!nextItem) return

      const nextEditorState = editorStates[nextItem.id]

      if (!nextEditorState) return

      const characterCounts = countCharactersOnLastBlockLines(
        item.id,
        editorRefs[instanceId][item.id]?.editorContainer,
        injectionRef.current!
      )

      if (!characterCounts) return

      const previousLinesCharacterCount = characterCounts
        .map((x, i, a) => i < a.length - 1 ? x : 0)
        .reduce((sum, x) => sum + x + 1, 0) - 2 // Magic -2 -> first and last carriage return
      const previousLineCharacterCount = (characterCounts[characterCounts.length - 2] ?? 0) + 1
      const lastLineCharacterCount = characterCounts[characterCounts.length - 1] ?? 0

      // Edge case
      // Consider this line:
      // React block text is an open-source Notion editor clone for React.
      // Here is what it can do:
      // If the caret is at the begining of "editor"
      // i.e. on the previous line longer than the last, at a position larger than the length of the last line
      // Don't go to the next block. Let the caret fall to the end of the last line
      if (
        previousLinesCharacterCount - previousLineCharacterCount <= offset
        && previousLinesCharacterCount + 1 >= offset
        && previousLineCharacterCount - previousLinesCharacterCount + offset >= lastLineCharacterCount
      ) return

      const nextFirstBlock = nextEditorState.getCurrentContent().getFirstBlock()
      const nextFocusOffset = Math.min(getLastLineFocusOffset(
        item.id,
        offset,
        editorRefs[instanceId][item.id]?.editorContainer,
        injectionRef.current!
      ), nextFirstBlock.getLength())
      const nextSelection = SelectionState.createEmpty(nextFirstBlock.getKey()).merge({
        anchorOffset: nextFocusOffset,
        focusOffset: nextFocusOffset,
      })
      const updatedNextEditorState = EditorState.forceSelection(nextEditorState, nextSelection)

      setEditorStates(x => ({ ...x, [nextItem.id]: updatedNextEditorState }))
      setFocusedIndex(index + 1)
    }

    setHoveredIndex(-1)
  }, [value, editorStates, instanceId, arrowData])

  /*
    ███╗   ███╗███████╗████████╗ █████╗
    ████╗ ████║██╔════╝╚══██╔══╝██╔══██╗
    ██╔████╔██║█████╗     ██║   ███████║
    ██║╚██╔╝██║██╔══╝     ██║   ██╔══██║
    ██║ ╚═╝ ██║███████╗   ██║   ██║  ██║
    ╚═╝     ╚═╝╚══════╝   ╚═╝   ╚═╝  ╚═╝
  */

  /* ---
    RETURN
    Handle carriage return
    If necessary, split block into two
  --- */
  const handleReturn = useCallback((index: number, event: any) => {
    if (queryMenuData) {
      event.preventDefault()

      return 'handled'
    }

    // On shift key we let the block break line normally
    if (event.shiftKey) return 'not-handled'

    const item = value[index]

    if (!item) return 'not-handled'

    const editorState = editorStates[item.id]

    if (!editorState) return 'not-handled'

    const pluginData = pluginsData.find(x => x.type === item.type)

    if (!pluginData) return 'not-handled'

    setQueryMenuData(null)

    const selection = editorState.getSelection()
    let contentState = editorState.getCurrentContent()

    // If the block is empty and the plugin is convertible to text, we convert it
    if (contentState.getPlainText() === '' && pluginData?.isConvertibleToText) {
      const nextEditorStates = { ...editorStates }
      let nextValue = [...value]

      nextValue[index] = {
        ...nextValue[index],
        type: 'text',
        metadata: '',
        indent: Math.max(0, Math.min(0, nextValue[index].indent)),
      }
      nextValue = applyMetadatas(index, nextValue, nextEditorStates)

      onChange(nextValue)
      setEditorStates(nextEditorStates)

      return 'handled'
    }

    // We want to split the block into two
    const firstBlock = contentState.getFirstBlock()
    const lastBlock = contentState.getLastBlock()
    const isBackward = selection.getIsBackward()
    let offset = 0 // How much text we removed before splitting into two blocks

    // If the selection is not collapsed, we remove the selected text
    if (!selection.isCollapsed()) {
      offset = Math.abs(selection.getAnchorOffset() - selection.getFocusOffset())
      contentState = Modifier.removeRange(contentState, selection, isBackward ? 'backward' : 'forward')
    }

    // Now we consider two selections: one to keep (in the second block) and one to remove (in the first block)
    const selectionToKeep = new SelectionState({
      anchorKey: firstBlock.getKey(),
      anchorOffset: 0,
      focusKey: isBackward ? selection.getFocusKey() : selection.getAnchorKey(),
      focusOffset: isBackward ? selection.getFocusOffset() : selection.getAnchorOffset(),
    })
    const selectionToRemove = new SelectionState({
      anchorKey: isBackward ? selection.getAnchorKey() : selection.getFocusKey(),
      anchorOffset: (isBackward ? selection.getAnchorOffset() : selection.getFocusOffset()) - offset,
      focusKey: lastBlock.getKey(),
      focusOffset: lastBlock.getText().length,
    })

    // We create a new block after the current one that splits the data into two
    // Then we focus it
    const nextFirstContentState = Modifier.removeRange(contentState, selectionToRemove, 'forward')
    const nextSecondContentState = Modifier.removeRange(contentState, selectionToKeep, 'forward')
    const nextEditorState = EditorState.push(editorState, nextFirstContentState, 'change-block-data')

    const emptySelection = SelectionState.createEmpty(nextSecondContentState.getFirstBlock().getKey())
    let secondEditorState = EditorState.forceSelection(EditorState.createWithContent(nextSecondContentState), emptySelection)
    const secondItem: ReactBlockTextDataItem = appendItemData(
      {
        reactBlockTextVersion: VERSION,
        id: nanoid(),
        type: pluginData.isNewItemOfSameType ? item.type : 'text',
        indent: item.indent,
      },
      secondEditorState
    )

    secondEditorState = applyStyles(item, secondEditorState)

    const nextEditorStates = { ...editorStates, [item.id]: nextEditorState, [secondItem.id]: secondEditorState }
    let nextValue = [...value]

    nextValue[index] = appendItemData(item, nextEditorState)
    nextValue.splice(index + 1, 0, secondItem)

    nextValue = applyMetadatas(index, nextValue, nextEditorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    setFocusedIndex(index + 1)
    setHoveredIndex(-1)
    setScrollIntoViewId(secondItem.id)

    return 'handled'
  }, [value, editorStates, queryMenuData, pluginsData, onChange, applyStyles, applyMetadatas])

  /* ---
    BACKSPACE
    Handle backspace input, if necessary merge blocks
  --- */
  const handleBackspace = useCallback((index: number) => {
    const item = value[index]

    if (!item) return 'not-handled'

    const editorState = editorStates[item.id]

    if (!editorState) return 'not-handled'

    const pluginData = pluginsData.find(x => x.type === item.type)

    if (!pluginData) return 'not-handled'

    const contentState = editorState.getCurrentContent()
    const firstBlockKey = contentState.getFirstBlock().getKey()
    const selection = editorState.getSelection()

    if (!(selection.isCollapsed() && selection.getAnchorOffset() === 0 && selection.getAnchorKey() === firstBlockKey)) return 'not-handled'
    // If the selection is collapsed and at the beginning of the block, we merge the block with the previous one

    setQueryMenuData(null)

    // If the item is indented, we unindent it
    if (item.indent > 0) {
      let nextValue = [...value]

      nextValue[index] = { ...nextValue[index], indent: item.indent - 1 }
      nextValue = applyMetadatas(index, nextValue, editorStates)

      onChange(nextValue)

      return 'handled'
    }

    // If the item is convertible to text, we convert it to a text item
    if (pluginData.isConvertibleToText) {
      let nextValue = [...value]

      nextValue[index] = {
        ...nextValue[index],
        type: 'text',
        metadata: '',
        indent: Math.max(0, Math.min(1, nextValue[index].indent)),
      }
      nextValue = applyMetadatas(index, nextValue, editorStates)

      onChange(nextValue)

      return 'handled'
    }

    // Otherwise we merge the blocks
    const previousItem = value[index - 1]

    if (!previousItem) return 'not-handled'

    let previousEditorState = editorStates[previousItem.id]

    if (!previousEditorState) return 'not-handled'

    let previousContent = previousEditorState.getCurrentContent()
    const previousLastBlock = previousContent.getLastBlock()
    // The first block text will be merged with the last block of the previous item
    const firstBlock = contentState.getFirstBlock()
    // The other block will be added to the previous item
    // Modify keys to avoid duplicates
    const otherBlocks = contentState
      .getBlocksAsArray()
      .slice(1)
      .map(block => new ContentBlock(block.set('key', nanoid())))
    const offset = previousLastBlock.getText().length
    // The end result selection will be at the end of the previous item
    const previousSelection = SelectionState.createEmpty(previousLastBlock.getKey()).merge({
      anchorOffset: offset,
      focusOffset: offset,
    })

    previousContent = Modifier.insertText(previousContent, previousSelection, firstBlock.getText())
    previousContent = ContentState.createFromBlockArray([
      ...previousContent.getBlocksAsArray(),
      ...otherBlocks,
    ])
    previousEditorState = EditorState.push(previousEditorState, previousContent, 'change-block-data')
    previousEditorState = EditorState.forceSelection(previousEditorState, previousSelection)
    previousEditorState = applyStyles(item, previousEditorState)

    const nextEditorStates = { ...editorStates, [previousItem.id]: previousEditorState }

    delete nextEditorStates[item.id]

    let nextValue = [...value]

    // Update the previous item
    nextValue[index - 1] = appendItemData(previousItem, previousEditorState)
    // Delete the current item
    nextValue.splice(index, 1)
    // Update metadatas
    nextValue = applyMetadatas(index - 1, nextValue, nextEditorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    setFocusedIndex(index - 1)
    setHoveredIndex(-1)

    return 'handled'
  }, [value, editorStates, pluginsData, onChange, applyStyles, applyMetadatas])

  /* ---
    META BACKSPACE
    Handle delete block on Backspace + Meta or Ctrl
  --- */
  const handleMetaBackspace = useCallback(() => {
    if (focusedIndex <= 0) return

    const item = value[focusedIndex]

    if (!item) return

    const pluginData = pluginsData.find(x => x.type === item.type)

    if (!pluginData) return

    // If in the previous state the first block is not empty, we don't delete the current item
    // Because it means that the user has deleted a block
    const previousEditorState = previousEditorStates[item.id]

    if (previousEditorState) {
      const previousFirstBlock = previousEditorState.getCurrentContent().getFirstBlock()

      if (previousFirstBlock.getText().length > 0) {
        // We refresh to update previousEditorStates
        setRefresh(x => !x)

        // But we can merge it with the previous one
        const previousSelection = previousEditorState.getSelection()

        // console.log('focusOffset', previousSelection.getFocusOffset())
        // If the selection is at the beggining of the first block
        if (previousSelection.isCollapsed() && previousSelection.getFocusOffset() === 0 && previousSelection.getAnchorKey() === previousFirstBlock.getKey()) {
          // console.log('merge')
          handleBackspace(focusedIndex)
        }

        return
      }
    }

    // If the item is indented, we unindent it
    if (item.indent > 0) {
      let nextValue = [...value]

      nextValue[focusedIndex] = { ...nextValue[focusedIndex], indent: item.indent - 1 }
      nextValue = applyMetadatas(focusedIndex, nextValue, editorStates)

      onChange(nextValue)

      return 'handled'
    }

    // If the item is convertible to text, we convert it to a text item
    if (pluginData.isConvertibleToText) {
      let nextValue = [...value]

      nextValue[focusedIndex] = {
        ...nextValue[focusedIndex],
        type: 'text',
        metadata: '',
        indent: Math.max(0, Math.min(1, nextValue[focusedIndex].indent)),
      }
      nextValue = applyMetadatas(focusedIndex, nextValue, editorStates)

      onChange(nextValue)

      return
    }

    const editorState = editorStates[item.id]

    if (!editorState) return

    const selection = editorState.getSelection()
    const contentState = editorState.getCurrentContent()
    const nBlocks = contentState.getBlockMap().size
    const firstBlockTextLength = contentState.getFirstBlock().getText().length

    if (!(selection.isCollapsed() && selection.getFocusOffset() === 0 && nBlocks <= 1 && firstBlockTextLength === 0)) return
    // If the selection if at the beginning of the only empty block, we delete the current item

    handleDeleteItem(focusedIndex)
    setFocusedIndex(focusedIndex - 1)
    setForceFocusIndex(focusedIndex - 1)

    // Then we put the caret at the end of the previous item
    const previousItem = value[focusedIndex - 1]

    if (!previousItem) return

    let nextPreviousEditorState = editorStates[previousItem.id]

    if (!nextPreviousEditorState) return

    const previousLastBlock = nextPreviousEditorState.getCurrentContent().getLastBlock()
    const previousLastBlockLength = previousLastBlock.getText().length
    const nextPreviousSelection = SelectionState.createEmpty(previousLastBlock.getKey()).merge({
      focusOffset: previousLastBlockLength,
      anchorOffset: previousLastBlockLength,
    })
    nextPreviousEditorState = EditorState.forceSelection(nextPreviousEditorState, nextPreviousSelection)

    setEditorStates(x => ({ ...x, [previousItem.id]: nextPreviousEditorState }))
  }, [value, editorStates, previousEditorStates, pluginsData, focusedIndex, handleBackspace, handleDeleteItem, onChange, applyMetadatas])

  /* ---
    DELETE
    Handle delete input, if necessary merge blocks
  --- */
  const handleDelete = useCallback((index: number) => {
    const item = value[index]

    if (!item) return 'not-handled'

    const editorState = editorStates[item.id]

    if (!editorState) return 'not-handled'

    const selection = editorState.getSelection()
    const lastBlock = editorState.getCurrentContent().getLastBlock()
    const lastBlockTextLength = lastBlock.getText().length

    if (!(selection.isCollapsed() && selection.getAnchorOffset() === lastBlockTextLength && selection.getAnchorKey() === lastBlock.getKey())) return 'not-handled'
    // If the selection is collapsed and at the end of the block, we merge the block with the next one

    const nextItem = value[index + 1]

    if (!nextItem) return 'not-handled'

    let nextEditorState = editorStates[nextItem.id]

    if (!nextEditorState) return 'not-handled'

    setQueryMenuData(null)

    let nextContent = nextEditorState.getCurrentContent()
    const nextFirstBlock = nextContent.getFirstBlock()
    // The last block text will be merged with the first block of the next item
    // The other block will be added to the next item
    // Modify keys to avoid duplicates
    const otherBlocks = editorState.getCurrentContent()
      .getBlocksAsArray()
      .slice(0, -1)
      .map(block => new ContentBlock(block.set('key', nanoid())))
    // The end result selection will be at the beginning of the next item, at lastBlockTextLength
    const nextSelection = SelectionState.createEmpty(nextFirstBlock.getKey()).merge({
      anchorOffset: lastBlockTextLength,
      focusOffset: lastBlockTextLength,
    })
    const nextSelectionToInsert = SelectionState.createEmpty(nextFirstBlock.getKey()).merge({
      anchorOffset: 0,
      focusOffset: 0,
    })

    nextContent = Modifier.insertText(nextContent, nextSelectionToInsert, lastBlock.getText())
    nextContent = ContentState.createFromBlockArray([
      ...otherBlocks,
      ...nextContent.getBlocksAsArray(),
    ])
    nextEditorState = EditorState.push(nextEditorState, nextContent, 'change-block-data')
    nextEditorState = EditorState.forceSelection(nextEditorState, nextSelection)

    const nextEditorStates = { ...editorStates, [nextItem.id]: nextEditorState }

    delete nextEditorStates[item.id]

    let nextValue = [...value]

    // Update the next item
    nextValue[index + 1] = appendItemData(nextItem, nextEditorState)
    // Preserve first item type
    nextValue[index + 1].type = item.type
    // Delete the current item
    nextValue.splice(index, 1)
    // Update metadatas
    nextValue = applyMetadatas(index, nextValue, nextEditorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    setFocusedIndex(index)
    setHoveredIndex(-1)

    return 'handled'
  }, [value, editorStates, onChange, applyMetadatas])

  /* ---
    INDENT AND OUTDENT
  --- */
  const handleIndent = useCallback((index: number, isIndent: boolean) => {
    const item = value[index]

    if (!item) return 'not-handled'

    const pluginData = pluginsData.find(x => x.type === item.type)

    if (!pluginData) return 'not-handled'

    const previousItem = value[index - 1]
    let nextValue = [...value]

    nextValue[index] = {
      ...item,
      indent: Math.max(
        0,
        Math.min(
          pluginData?.maxIndent ?? 0,
          isIndent ? item.indent + 1 : item.indent - 1,
          (previousItem?.indent ?? 0) + 1
        )
      ),
    }
    nextValue = applyMetadatas(index, nextValue, editorStates)

    onChange(nextValue)
    setHoveredIndex(-1)

    return 'handled'
  }, [value, editorStates, pluginsData, onChange, applyMetadatas])

  /*
    ███████╗ ██████╗  ██████╗██╗   ██╗███████╗
    ██╔════╝██╔═══██╗██╔════╝██║   ██║██╔════╝
    █████╗  ██║   ██║██║     ██║   ██║███████╗
    ██╔══╝  ██║   ██║██║     ██║   ██║╚════██║
    ██║     ╚██████╔╝╚██████╗╚██████╔╝███████║
    ╚═╝      ╚═════╝  ╚═════╝ ╚═════╝ ╚══════╝
  */

  /* ---
    BLOCK MOUSE DOWN
  --- */
  const handleBlockMouseDown = useCallback(() => {
    setSelectionText(null)
  }, [])

  /* ---
    FOCUS
  --- */
  const handleFocus = useCallback((index: number) => {
    setFocusedIndex(index)
    setSelectionText(null)
  }, [])

  /* ---
    BLUR
  --- */
  const handleBlur = useCallback(() => {
    setSelectionText(null)
  }, [])

  /* ---
    FOCUS CONTENT
  --- */
  const handleFocusContent = useCallback((index: number, atStart = false, atEnd = false) => {
    const item = value[index]

    if (!item) return

    forceContentFocus(editorRefs[instanceId], item.id)

    if (!(atStart || atEnd)) return

    const editorState = editorStates[item.id]

    if (!editorState) return

    const contentState = editorState.getCurrentContent()
    let selection: SelectionState

    if (atStart) {
      selection = SelectionState.createEmpty(contentState.getFirstBlock().getKey())
    }
    else {
      const lastBlock = contentState.getLastBlock()

      selection = SelectionState.createEmpty(lastBlock.getKey()).merge({
        focusOffset: lastBlock.getText().length,
        anchorOffset: lastBlock.getText().length,
      })
    }

    const nextEditorState = EditorState.forceSelection(editorState, selection)

    setEditorStates(x => ({ ...x, [item.id]: nextEditorState }))
  }, [value, editorStates, instanceId])

  /* ---
    BLUR CONTENT
  --- */
  const handleBlurContent = useCallback((index: number) => {
    const item = value[index]

    if (!item) return

    editorRefs[instanceId][item.id]?.blur()
  }, [value, instanceId])

  const handleForceBlurContent = useCallback((index: number) => {
    setForceBlurIndex(index)
  }, [])

  /* ---
    BLUR ALL CONTENT
  --- */
  const handleBlurAllContent = useCallback(() => {
    const allEditorRefs = Object.values(editorRefs[instanceId] ?? {})

    allEditorRefs.forEach(editorRef => editorRef?.blur())
  }, [instanceId])

  /* ---
    ROOT DIV BLUR
  --- */
  const handleRootBlur = useCallback(() => {
    setSelectionText(null)
  }, [])

  /* ---
    ROOT OUTSIDE CLICK
  --- */
  const handleOutsideClick = useCallback((event: MouseEvent) => {
    if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
      handleRootBlur()
      handleBlurAllContent()
    }
  }, [handleRootBlur, handleBlurAllContent])

  /*
    ██████╗ ██████╗  █████╗  ██████╗      █████╗ ███╗   ██╗██████╗     ██████╗ ██████╗  ██████╗ ██████╗
    ██╔══██╗██╔══██╗██╔══██╗██╔════╝     ██╔══██╗████╗  ██║██╔══██╗    ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗
    ██║  ██║██████╔╝███████║██║  ███╗    ███████║██╔██╗ ██║██║  ██║    ██║  ██║██████╔╝██║   ██║██████╔╝
    ██║  ██║██╔══██╗██╔══██║██║   ██║    ██╔══██║██║╚██╗██║██║  ██║    ██║  ██║██╔══██╗██║   ██║██╔═══╝
    ██████╔╝██║  ██║██║  ██║╚██████╔╝    ██║  ██║██║ ╚████║██████╔╝    ██████╔╝██║  ██║╚██████╔╝██║
    ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝     ╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝     ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝
  */

  /* ---
    DRAG START
  --- */
  const handleDragStart = useCallback((dropIndex: number) => {
    setDragData({ dropIndex, dragIndex: dropIndex, isTop: null })

    const selectedIndexes = getSelectionRectIndexes()

    if (selectedIndexes.includes(dropIndex)) return

    setSelectionRect(null)
  }, [getSelectionRectIndexes])

  /* ---
    DRAG
  --- */
  const handleDrag = useCallback((dropIndex: number, isTop: boolean | null) => {
    setDragData(x => x ? ({ ...x, dropIndex, isTop }) : null)
  }, [])

  /* ---
    DRAG END
    Move items at the end of a drag session
  --- */
  const handleDragEnd = useCallback((singleDragIndex: number) => {
    setDragData(null)
    setFocusedIndex(-1)
    handleBlurAllContent()

    if (!dragData) return

    const { dropIndex, isTop } = dragData
    const selectedIndexes = getSelectionRectIndexes()
    const dragIndexes = selectedIndexes.length ? selectedIndexes : [singleDragIndex]

    if (dragIndexes.includes(dropIndex)) return

    const finalDropIndex = isTop ? dropIndex : dropIndex + 1
    const isDropAfter = dragIndexes.some(i => i > finalDropIndex)
    const hoveredIndex = isDropAfter ? finalDropIndex : finalDropIndex - 1
    let nextValue = [...value]

    if (isDropAfter) {
      nextValue.splice(finalDropIndex, 0, ...dragIndexes.map(i => value[i]))
      nextValue.splice(dragIndexes[0] + dragIndexes.length, dragIndexes.length)
    }
    else {
      nextValue.splice(finalDropIndex, 0, ...dragIndexes.map(i => value[i]))
      nextValue.splice(dragIndexes[0], dragIndexes.length)
    }

    nextValue = applyMetadatas(finalDropIndex, nextValue, editorStates)

    onChange(nextValue)
    setHoveredIndex(hoveredIndex)
  }, [
    value,
    editorStates,
    dragData,
    onChange,
    applyMetadatas,
    handleBlurAllContent,
    getSelectionRectIndexes,
  ])

  /*
     ██████╗ ██████╗ ██████╗ ██╗   ██╗    ██████╗  █████╗ ███████╗████████╗███████╗
    ██╔════╝██╔═══██╗██╔══██╗╚██╗ ██╔╝    ██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██╔════╝
    ██║     ██║   ██║██████╔╝ ╚████╔╝     ██████╔╝███████║███████╗   ██║   █████╗
    ██║     ██║   ██║██╔═══╝   ╚██╔╝      ██╔═══╝ ██╔══██║╚════██║   ██║   ██╔══╝
    ╚██████╗╚██████╔╝██║        ██║       ██║     ██║  ██║███████║   ██║   ███████╗
     ╚═════╝ ╚═════╝ ╚═╝        ╚═╝       ╚═╝     ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝
  */

  /* ---
    COPY
    Write selected items to clipboard
  --- */
  const handleWindowCopy = useCallback(() => {
    if (!(selectionText && selectionText.items.length)) return

    navigator.clipboard.writeText(JSON.stringify(selectionText.items))

    const element = document.createElement('div')

    element.innerText = JSON.stringify(selectionText.items)

    // console.log('copy xxx', selectionText.text)
    navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([selectionText.text], { type: 'text/plain' }),
      'text/html': new Blob([element.innerHTML], { type: 'text/html' }),
    })])
  }, [selectionText])

  /* ---
    PASTE
    Handle paste of text, ~images, files~ or blocks
  --- */
  const handlePasteText = useCallback((index: number, text: string) => {
    const item = value[index]

    if (!item) return

    const editorState = editorStates[item.id]

    if (!editorState) return

    const contentState = Modifier.insertText(editorState.getCurrentContent(), editorState.getSelection(), text)

    const nextEditorState = EditorState.push(editorState, contentState, 'insert-characters')

    setEditorStates(x => ({ ...x, [item.id]: nextEditorState }))

    let nextValue = [...value]

    nextValue.splice(index, 1, appendItemData(item, nextEditorState))

    nextValue = applyMetadatas(index, nextValue, editorStates)

    onChange(nextValue)
  }, [value, editorStates, onChange, applyMetadatas])

  const handlePasteItems = useCallback((index: number, items: ReactBlockTextDataItem[]) => {
    console.log('handlePasteItems', index, items)
    // const item = value[index]

    // if (!item) return

    // const editorState = editorStates[item.id]

    // if (!editorState) return

    // EditorState.createWithContent(convertFromRaw(JSON.parse(item.data)))
    // }, [value, editorStates])
  }, [])

  const handleActualPaste = useCallback(async (index: number) => {
    const clipboardItems = await window.navigator.clipboard.read()

    const htmlClipboardItem = clipboardItems.find(x => x.types.includes('text/html'))

    let parsedData = null

    if (htmlClipboardItem) {
      const blob = await htmlClipboardItem?.getType('text/html')

      const html = await blob?.text()

      const element = document.createElement('div')

      element.innerHTML = html || ''

      const data = element.innerText

      try {
        parsedData = JSON.parse(data)
      }
      catch (error) {
        //
      }
    }

    if (Array.isArray(parsedData) && parsedData[0] && typeof parsedData[0].reactBlockTextVersion === 'string') {
      handlePasteItems(index, parsedData)

      return
    }

    const text = await window.navigator.clipboard.readText()

    handlePasteText(index, text)
  }, [handlePasteText, handlePasteItems])

  // Passed to editor component
  const handlePaste = useCallback((index: number) => {
    handleActualPaste(index)

    return 'handled'
  }, [handleActualPaste])

  /*
    ███╗   ███╗███████╗███╗   ██╗██╗   ██╗███████╗
    ████╗ ████║██╔════╝████╗  ██║██║   ██║██╔════╝
    ██╔████╔██║█████╗  ██╔██╗ ██║██║   ██║███████╗
    ██║╚██╔╝██║██╔══╝  ██║╚██╗██║██║   ██║╚════██║
    ██║ ╚═╝ ██║███████╗██║ ╚████║╚██████╔╝███████║
    ╚═╝     ╚═╝╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
  */

  /* ---
    CONTEXT MENU SELECT
    Handle context menu item selection after `/` then `enter` or click
  --- */
  const handleContextMenuSelect = useCallback((command: ReactBlockTextDataItemType) => {
    setQueryMenuData(null)

    const { id, noSlash } = queryMenuData!
    const item = value.find(x => x.id === id)

    if (!item) return
    if (item.type === command) return

    const editorState = editorStates[id]

    if (!editorState) return

    const currentSelection = editorState.getSelection()
    const blockKey = currentSelection.getStartKey()
    const block = editorState.getCurrentContent().getBlockForKey(blockKey)
    const originalOffset = currentSelection.getFocusOffset()
    let blockText = block.getText()
    let offset = originalOffset

    // Remove text after `/`
    while (offset > 0 && blockText[offset - 1] !== '/' && blockText[offset - 1] !== ' ') {
      offset--
      blockText = blockText.slice(0, -1)
    }

    if (!noSlash) {
      // Remove '/'
      blockText = blockText.slice(0, -1)
      offset--
    }

    // The command query to remove
    const selectionStateToRemove = SelectionState.createEmpty(blockKey).merge({
      focusOffset: originalOffset,
      anchorOffset: offset,
    })
    // The selection after the removal of the command query
    const selectionStateToApply = SelectionState.createEmpty(blockKey).merge({
      focusOffset: offset,
      anchorOffset: offset,
    })
    const nextContent = Modifier.removeRange(editorState.getCurrentContent(), selectionStateToRemove, 'forward')
    let nextEditorState = EditorState.push(editorState, nextContent, 'change-block-data')

    nextEditorState = EditorState.forceSelection(nextEditorState, selectionStateToApply)

    const nextEditorStates = { ...editorStates, [id]: nextEditorState }

    let nextValue = [...value]
    const index = nextValue.indexOf(item)
    nextValue.splice(index, 1, appendItemData({ ...item, type: command }, nextEditorState))

    nextValue = applyMetadatas(index, nextValue, editorStates)

    onChange(nextValue)
    setEditorStates(nextEditorStates)
    // Update previousEditorState to clear the command query from them
    setShouldTriggerRefresh(true)
  }, [value, editorStates, queryMenuData, onChange, applyMetadatas])

  /* ---
    BLOCK MENU CLOSE
  --- */
  const handleBlockMenuClose = useCallback(() => {
    setIsBlockMenuOpen(false)
    handleBlurAllContent()
  }, [handleBlurAllContent])

  /*
    ███████╗███████╗██╗     ███████╗ ██████╗████████╗██╗ ██████╗ ███╗   ██╗
    ██╔════╝██╔════╝██║     ██╔════╝██╔════╝╚══██╔══╝██║██╔═══██╗████╗  ██║
    ███████╗█████╗  ██║     █████╗  ██║        ██║   ██║██║   ██║██╔██╗ ██║
    ╚════██║██╔══╝  ██║     ██╔══╝  ██║        ██║   ██║██║   ██║██║╚██╗██║
    ███████║███████╗███████╗███████╗╚██████╗   ██║   ██║╚██████╔╝██║ ╚████║
    ╚══════╝╚══════╝╚══════╝╚══════╝ ╚═════╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
  */

  /* ---
    SELECTION RECT CHANGE
  --- */
  const handleSelectionRect = useCallback((x: number, y: number) => {
    setSelectionRect(r => {
      if (!r) return null

      const nextSelectionRect = {
        ...r,
        top: Math.max(0, Math.min(r.anchorTop, y)),
        left: Math.max(0, Math.min(r.anchorLeft, x)),
        width: Math.max(2, Math.abs(x - r.anchorLeft)),
        height: Math.max(2, Math.abs(y - r.anchorTop)),
      }

      nextSelectionRect.selectedIds = findSelectionRectIds(selectionRefs[instanceId], nextSelectionRect)

      return nextSelectionRect
    })

    window.getSelection()?.removeAllRanges()
  }, [instanceId])

  /* ---
    SCROLL SPEED
    Set the current scroll speed based on the mouse position
  --- */
  const handleScrollSpeed = useCallback((_x: number, y: number) => {
    if (!rootRef.current) return

    const parent = findScrollParent(rootRef.current)
    const { height: childHeight } = rootRef.current.getBoundingClientRect()
    const { height: parentHeight } = parent.getBoundingClientRect()
    const relativeTop = rootRef.current.offsetTop - parent.offsetTop
    const relativeY = y - parent.scrollTop + relativeTop
    const finalHeight = Math.min(parentHeight, window.innerHeight)

    // Scroll top only if child's top is not visible
    if (parent.scrollTop > relativeTop && relativeY < SELECTION_RECT_SCROLL_OFFSET) {
      setScrollSpeed(BASE_SCROLL_SPEED * (relativeY - SELECTION_RECT_SCROLL_OFFSET) / SELECTION_RECT_SCROLL_OFFSET)

      return
    }

    // Scroll bottom only if child's bottom is not visible
    if (parent.scrollTop + finalHeight < childHeight + relativeTop && relativeY > finalHeight - SELECTION_RECT_SCROLL_OFFSET) {
      setScrollSpeed(-BASE_SCROLL_SPEED * (finalHeight - relativeY - SELECTION_RECT_SCROLL_OFFSET) / SELECTION_RECT_SCROLL_OFFSET)

      return
    }

    setScrollSpeed(0)
  }, [])

  /* ---
    PARENT SCROLL
  --- */
  const handleParentScroll = useCallback(() => {
    if (!(selectionRect && selectionRect.isSelecting)) return
    if (!rootRef.current) return

    const { x, y } = getRelativeMousePosition(rootRef.current!, lastMousePosition)

    handleSelectionRect(x, y)
  }, [selectionRect, handleSelectionRect])

  /* ---
    ROOT MOUSE MOVE
    Set selection rect if selecting
  --- */
  const handleRootMouseMove = useCallback((event: ReactMouseEvent) => {
    if (!(selectionRect && selectionRect.isSelecting)) return

    lastMousePosition = {
      x: event.clientX,
      y: event.clientY,
    }

    const { x, y } = getRelativeMousePosition(rootRef.current!, lastMousePosition)

    handleScrollSpeed(x, y)
    handleSelectionRect(x, y)
  }, [selectionRect, handleScrollSpeed, handleSelectionRect])

  /* ---
    ROOT MOUSE LEAVE
  --- */
  const handleRootMouseLeave = useCallback(() => {
    if (!(selectionRect && selectionRect.isSelecting)) return

    window.getSelection()?.removeAllRanges()
  }, [selectionRect])

  /* ---
    SINGLE BLOCK SELECTION
  --- */
  const handleSingleBlockSelection = useCallback((id: string) => {
    if (readOnly) return

    setSelectionRect({
      isSelecting: false,
      anchorTop: 0,
      anchorLeft: 0,
      top: 0,
      left: 0,
      width: 0,
      height: 0,
      selectedIds: [id],
    })

    window.getSelection()?.removeAllRanges()
  }, [readOnly])

  /* ---
    RECT SELECTION START
  --- */
  const handleRectSelectionStart = useCallback((event: ReactMouseEvent) => {
    if (readOnly) return

    lastMousePosition = {
      x: event.clientX,
      y: event.clientY,
    }

    const { x, y } = getRelativeMousePosition(rootRef.current!, lastMousePosition)

    setSelectionRect({
      isSelecting: true,
      anchorTop: y,
      anchorLeft: x,
      top: y,
      left: x,
      width: 0,
      height: 0,
      selectedIds: [],
    })
  }, [readOnly])

  /* ---
    RECT SELECTION END
  --- */
  const handleRectSelectionEnd = useCallback(() => {
    setScrollSpeed(0)

    if (!selectionRect) return

    if (selectionRect.selectedIds.length) {
      setSelectionRect({
        ...selectionRect,
        isSelecting: false,
      })

      return
    }

    setSelectionRect(null)
  }, [selectionRect])

  /* ---
    MULTI BLOCK TEXT SELECTION END
    Triggered when a text selection ends
    Set selectedItems with the content of the selected blocks
    Trimmed at the beginning and end to fit to selection
    When selecting the editor goes into read-only mode, to allow selection between multiple contenteditable divs
    This handler is invoked at mouseup
  --- */
  const handleMultiBlockTextSelectionEnd = useCallback((id: string, blockKey: string, text: string) => {
    const itemIndex = value.findIndex(x => x.id === id)

    if (itemIndex === -1) return

    // Find blockIndex, the index of the start block for the selected text
    const editorState = editorStates[id]
    let blockIndex = -1

    if (!editorState) return

    editorState.getCurrentContent().getBlocksAsArray().forEach((block, blockI) => {
      if (block.getKey() === blockKey) {
        blockIndex = blockI
      }
    })

    // Find selected text
    let textWithLineBreaks = ''
    // Find selected blocks
    const selected: ReactBlockTextDataItem[] = []
    // The text that has been selected
    let textToCut = text
    let complete = false

    value.forEach((item, valueI) => {
      if (complete) return
      if (valueI < itemIndex) return

      const editorState = editorStates[item.id]

      if (!editorState) {
        selected.push(item)

        return
      }

      const blocks = editorState.getCurrentContent().getBlocksAsArray()
      let nextEditorState = editorState
      let consideredBlocks = [...blocks]

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i]

        // Start only at selected block, remove blocks before that
        if (itemIndex === valueI && i < blockIndex) {
          consideredBlocks = consideredBlocks.filter(b => b !== block)

          nextEditorState = EditorState.push(
            nextEditorState,
            ContentState.createFromBlockArray(consideredBlocks),
            'change-block-data'
          )

          continue
        }

        textWithLineBreaks += '\n'

        let blockComplete = false
        const blockText = block.getText()
        const emptySelection = SelectionState.createEmpty(block.getKey())
        const selectionsToRemove = []

        // Cut from start to x
        for (let j = 1; j <= blockText.length; j++) {
          const blockTextSlice = blockText.slice(0, j)

          if (textToCut === blockTextSlice) {
            selectionsToRemove.push(emptySelection.merge({
              anchorOffset: j,
              focusOffset: blockText.length,
            }))
            blockComplete = true
            complete = true
            textWithLineBreaks += blockTextSlice
            textToCut = ''
            break
          }
        }

        // Cut from x to end
        if (!blockComplete) {
          for (let j = 0; j < blockText.length; j++) {
            const blockTextSlice = blockText.slice(j)

            if (textToCut.startsWith(blockTextSlice)) {
              selectionsToRemove.push(emptySelection.merge({
                anchorOffset: 0,
                focusOffset: j,
              }))
              blockComplete = true
              textToCut = textToCut.slice(blockTextSlice.length)
              textWithLineBreaks += blockTextSlice
              break
            }
          }
        }

        // Cut from x to y
        if (!blockComplete) {
          dance: for (let j = 0; j < blockText.length; j++) {
            for (let k = j + 1; k < blockText.length; k++) {
              const blockTextSlice = blockText.slice(j, k)

              if (textToCut === blockTextSlice) {
                selectionsToRemove.push(
                  emptySelection.merge({
                    anchorOffset: 0,
                    focusOffset: j,
                  }),
                  emptySelection.merge({
                    anchorOffset: k - j,
                    focusOffset: blockText.length - j,
                  })
                )
                blockComplete = true
                complete = true
                textWithLineBreaks += blockTextSlice
                textToCut = ''
                break dance
              }
            }
          }
        }

        if (textToCut.length === 0) {
          complete = true
        }

        let nextContent = nextEditorState.getCurrentContent()

        selectionsToRemove.forEach(selection => {
          nextContent = Modifier.removeRange(nextContent, selection, 'forward')
        })

        nextEditorState = EditorState.push(nextEditorState, nextContent, 'change-block-data')

        if (complete) {
          // Remove following blocks
          const nextBlocks = nextContent.getBlocksAsArray().filter((_b, bi) => bi + blocks.length - consideredBlocks.length <= i)

          nextEditorState = EditorState.push(
            nextEditorState,
            ContentState.createFromBlockArray(nextBlocks),
            'change-block-data'
          )

          break
        }
      }

      selected.push(appendItemData(item, nextEditorState))
    })

    // Remove first \n
    textWithLineBreaks = textWithLineBreaks.slice(1)

    // Finally set the selection data for copy/paste
    setSelectionText({
      startId: id,
      items: selected,
      text: textWithLineBreaks,
    })
  }, [value, editorStates])

  /* ---
    MULTI BLOCK SELECTION MOUSE UP
    Handle the mouse up event when selecting multiple blocks
    If the selection is not empty, set the selected items
  --- */
  const handleWindowMouseUp = useCallback((event: MouseEvent) => {
    if (selectionRect?.isSelecting) {
      handleRectSelectionEnd()
    }
    else {
      setSelectionRect(null)
    }

    if (!isSelecting) return

    isSelecting = false

    setRefresh(x => !x)

    try {
      const range = window.getSelection()?.getRangeAt(0)
      const text = range?.toString()

      if (range && text) {
        const parentElement = range.startContainer.parentElement!

        const dataOffsetKey = findAttributeInParents(parentElement, 'data-offset-key')
        const dataReactBlockTextId = findAttributeInParents(parentElement, 'data-react-block-text-id')

        if (!(dataOffsetKey && dataReactBlockTextId)) return

        const blockKey = dataOffsetKey.split('-')[0]

        if (blockKey) {
          handleMultiBlockTextSelectionEnd(dataReactBlockTextId, blockKey, text)
        }
      }
      // Force break a focus bug
      else {
        // Prevent force focus happening on block add button click
        if (findParentWithId(event.target as HTMLElement, ADD_ITEM_BUTTON_ID)) return

        setForceFocusIndex(hoveredIndex)
      }
    }
    catch (error) {
      //
    }
  }, [hoveredIndex, selectionRect, handleRectSelectionEnd, handleMultiBlockTextSelectionEnd])

  /*
     ██████╗ ██████╗ ███╗   ███╗███╗   ███╗ █████╗ ███╗   ██╗██████╗ ███████╗
    ██╔════╝██╔═══██╗████╗ ████║████╗ ████║██╔══██╗████╗  ██║██╔══██╗██╔════╝
    ██║     ██║   ██║██╔████╔██║██╔████╔██║███████║██╔██╗ ██║██║  ██║███████╗
    ██║     ██║   ██║██║╚██╔╝██║██║╚██╔╝██║██╔══██║██║╚██╗██║██║  ██║╚════██║
    ╚██████╗╚██████╔╝██║ ╚═╝ ██║██║ ╚═╝ ██║██║  ██║██║ ╚████║██████╔╝███████║
     ╚═════╝ ╚═════╝ ╚═╝     ╚═╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═════╝ ╚══════╝
  */

  /* ---
    HANDLE KEY COMMANDS
    Respond to the editor's key-bound commands
  --- */
  const handleKeyCommand = useCallback((index: number, command: string) => {
    if (command === COMMANDS.SAVE) {
      onSave?.()

      return 'handled'
    }

    if (command === 'backspace' || command === 'backspace-to-start-of-line') {
      return handleBackspace(index)
    }

    if (command === 'delete') {
      return handleDelete(index)
    }

    if (command === COMMANDS.INDENT || command === COMMANDS.OUTDENT) {
      return handleIndent(index, command === COMMANDS.INDENT)
    }

    console.log('command not handled', command)

    return 'not-handled'
  }, [onSave, handleBackspace, handleDelete, handleIndent])

  /* ---
    WINDOW KEYDOWN
  --- */
  const handleWindowKeyDown = useCallback((event: KeyboardEvent) => {
    if (event.key === 'Backspace' && (event.metaKey || event.ctrlKey)) {
      handleMetaBackspace()
    }

    // TODO: remove this if necessary
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      setShouldTriggerRefresh(true)

      setTimeout(() => {
        setShouldTriggerRefresh(true)
      }, 1)
    }
  }, [handleMetaBackspace])

  /*
    ███████╗██╗██████╗ ███████╗    ███████╗███████╗███████╗███████╗ ██████╗████████╗███████╗
    ██╔════╝██║██╔══██╗██╔════╝    ██╔════╝██╔════╝██╔════╝██╔════╝██╔════╝╚══██╔══╝██╔════╝
    ███████╗██║██║  ██║█████╗      █████╗  █████╗  █████╗  █████╗  ██║        ██║   ███████╗
    ╚════██║██║██║  ██║██╔══╝      ██╔══╝  ██╔══╝  ██╔══╝  ██╔══╝  ██║        ██║   ╚════██║
    ███████║██║██████╔╝███████╗    ███████╗██║     ██║     ███████╗╚██████╗   ██║   ███████║
    ╚══════╝╚═╝╚═════╝ ╚══════╝    ╚══════╝╚═╝     ╚═╝     ╚══════╝ ╚═════╝   ╚═╝   ╚══════╝
  */

  /* ---
    INITIAL VALUE POPULATION
    To create the editorStates and apply styles
  --- */
  useEffect(() => {
    if (!(Array.isArray(value) && value.length)) return

    const editorStates = value.map(item => ({
      item,
      editorState: item.data
        ? EditorState.createWithContent(convertFromRaw(JSON.parse(item.data)))
        : EditorState.createEmpty(),
    }))
    .reduce((acc, x) => ({ ...acc, [x.item.id]: applyStyles(x.item, x.editorState) }), {})

    setEditorStates(editorStates)
    setShouldBlurAllContent(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ---
    NO VALUE LENGTH
    Create a text item if there is no value
  --- */
  useEffect(() => {
    if (value.length) return
    if (readOnly) return

    const { editorState, item } = createTextItem()

    setEditorStates(x => ({ ...x, [item.id]: editorState }))
    onChange([item])
    setFocusedIndex(0)
  }, [value, readOnly, onChange, createTextItem])

  /* ---
    READ ONLY UPDATE
    Update the editor states based on value if readOnly
  --- */
  useEffect(() => {
    if (!readOnly) return

    const nextEditorStates = value.map(item => ({
      id: item.id,
      editorState: EditorState.createWithContent(convertFromRaw(JSON.parse(item.data))),
    }))
    .reduce((acc, item) => ({ ...acc, [item.id]: item.editorState }), {})

    setEditorStates(nextEditorStates)
  }, [readOnly, value])

  /* ---
    UP AND DOWN ARROW
  --- */
  useEffect(() => {
    handleArrow()
  }, [handleArrow])

  /* ---
    FORCE FOCUS
    Handle forcing focus on a specific block
  --- */
  useEffect(() => {
    if (readOnly) return
    if (forceFocusIndex === -1) return
    if (lastForceFocusTime + 3 * 16 > Date.now()) return

    lastForceFocusTime = Date.now()

    setForceFocusIndex(-1)
    forceContentFocus(editorRefs[instanceId], value[forceFocusIndex]?.id)
  }, [value, readOnly, instanceId, forceFocusIndex, editorStates])

  /* ---
    FORCE BLUR
    Handle forcing blur on a specific block
  --- */
  useEffect(() => {
    if (readOnly) return
    if (forceBlurIndex === -1) return

    setForceBlurIndex(-1)

    const item = value[forceBlurIndex]

    if (!item) return

    editorRefs[instanceId][item.id]?.blur()
  }, [value, readOnly, instanceId, forceBlurIndex])

  /* ---
    FORCE BLUR ALL CONTENT
    Handle forcing blur on every block
  --- */
  useEffect(() => {
    if (!shouldBlurAllContent) return

    setShouldBlurAllContent(false)
    handleBlurAllContent()
  }, [shouldBlurAllContent, handleBlurAllContent])

  /* ---
    FORCE REFRESH
  --- */
  useEffect(() => {
    if (!shouldTriggerRefresh) return

    setRefresh(x => !x)
  }, [shouldTriggerRefresh])

  /* ---
    FORCE DISPLAY QUERY MENU
    On block created
  --- */
  useEffect(() => {
    if (!shouldDisplayQueryMenu) return

    setShouldDisplayQueryMenu(false)

    const item = value[focusedIndex]

    if (!item) return

    const editorState = editorStates[item.id]

    if (!editorState) return

    const queryMenuData = getQueryMenuData(editorRefs[instanceId], item.id, rootRef.current!)

    if (!queryMenuData) return

    setQueryMenuData({
      ...queryMenuData,
      noSlash: true,
    })
  }, [
    shouldDisplayQueryMenu,
    value,
    editorStates,
    focusedIndex,
    instanceId,
  ])

  /* ---
    SCROLL PARENT WHEN SELECTION RECT
  --- */
  useEffect(() => {
    cancelAnimationFrame(scrollParentFrame)

    if (!scrollSpeed) return

    const child = rootRef.current

    if (!child) return

    const parent = findScrollParent(child)
    const { height: childHeight } = child.getBoundingClientRect()
    const { height: parentHeight } = parent.getBoundingClientRect()
    const finalHeight = Math.min(parentHeight, window.innerHeight)

    const loop = () => {
      scrollParentFrame = requestAnimationFrame(() => {
        const relativeTop = child.offsetTop - parent.offsetTop

        // Don't overscroll top
        if (scrollSpeed < 0 && parent.scrollTop < relativeTop) return

        // Don't overscroll bottom
        if (scrollSpeed > 0 && parent.scrollTop + finalHeight > childHeight + relativeTop) return

        parent.scrollBy({
          top: scrollSpeed,
          behavior: 'auto',
        })
        loop()
      })
    }

    loop()
  }, [scrollSpeed])

  /* ---
    SCROLL PARENT TO UPDATE SELECTION RECT
  --- */
  useEffect(() => {
    if (!rootRef.current) return

    const scrollParent = findScrollParent(rootRef.current)

    window.addEventListener('scroll', handleParentScroll, { passive: true })
    scrollParent.addEventListener('scroll', handleParentScroll, { passive: true })

    return () => {
      window.removeEventListener('scroll', handleParentScroll)
      scrollParent.removeEventListener('scroll', handleParentScroll)
    }
  }, [handleParentScroll])

  /* ---
    SCROLL INTO VIEW
    Handle scrolling a specific block into view
  --- */
  useEffect(() => {
    if (!scrollIntoViewId) return

    setScrollIntoViewId(null)

    const element = selectionRefs[instanceId]?.[scrollIntoViewId]

    if (!element) return

    // children[0] is a special element that is offseted from its parent by a few px
    // So scrolling it into view scrolls a bit more than the parent
    // See Block component
    element.children[0].scrollIntoView({
      behavior: 'instant',
      inline: 'nearest',
      block: 'nearest',
    })
  }, [instanceId, scrollIntoViewId])

  /* ---
    DRAG SIDE EFFECT
    Prevent hoveredIndex from being set to dragIndex after dragging
  --- */
  useEffect(() => {
    requestAnimationFrame(() => {
      setWasDragging(!!dragData)
    })
  }, [dragData])

  /* ---
    MULTI BLOCK SELECTION EVENTS
    Handle multi block selection by adding two listeners: mouseup and mousemove
    mouseup will check if the selection is valid and call handleMultiBlockSelection
    mousemove will trigger the selecting state if the mouse is down
  --- */
  useEffect(() => {
    window.addEventListener('mouseup', handleWindowMouseUp)

    return () => {
      window.removeEventListener('mouseup', handleWindowMouseUp)
    }
  }, [handleWindowMouseUp])

  useEffect(() => {
    const handleWindowMouseMove = (event: MouseEvent) => {
      // Start selection only if the mouse is down
      if (event.buttons !== 1) return
      // Prevent selection on drag
      if (findParentWithId(event.target as HTMLElement, DRAG_ITEM_BUTTON_ID)) return

      isSelecting = true
    }

    window.addEventListener('mousemove', handleWindowMouseMove)

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove)
    }
  }, [])

  /* ---
    KEYDOWN EVENT
  --- */
  useEffect(() => {
    window.addEventListener('keydown', handleWindowKeyDown)

    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown)
    }
  }, [handleWindowKeyDown])

  /* ---
    OUTSIDE CLICK EVENT
  --- */
  useEffect(() => {
    window.addEventListener('click', handleOutsideClick)

    return () => {
      window.removeEventListener('click', handleOutsideClick)
    }
  }, [handleOutsideClick])

  /* ---
    COPY EVENT
  --- */
  useEffect(() => {
    window.addEventListener('copy', handleWindowCopy)

    return () => {
      window.removeEventListener('copy', handleWindowCopy)
    }
  }, [handleWindowCopy])

  /* ---
    REACT DND BACKEND CLEANUP
    Fixes a bug where the backend is not cleaned up when the editor is unmounted
  --- */
  useEffect(() => {
    if (window.__isReactDndBackendSetUp) {
      window.__isReactDndBackendSetUp = false
    }
  }, [])

  /*
    ██████╗ ███████╗███╗   ██╗██████╗ ███████╗██████╗
    ██╔══██╗██╔════╝████╗  ██║██╔══██╗██╔════╝██╔══██╗
    ██████╔╝█████╗  ██╔██╗ ██║██║  ██║█████╗  ██████╔╝
    ██╔══██╗██╔══╝  ██║╚██╗██║██║  ██║██╔══╝  ██╔══██╗
    ██║  ██║███████╗██║ ╚████║██████╔╝███████╗██║  ██║
    ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═╝  ╚═╝
  */

  /* ---
    GET IS DRAGGING TOP
    Get if the block should display the top dragging indicator (true | false for bottom | null for none)
  --- */
  const getIsDraggingTop = useCallback((index: number) => {
    const selectedIndexes = getSelectionRectIndexes()

    // Allow drop on top of the first rect selected block
    selectedIndexes.shift()

    return selectedIndexes.includes(index)
      ? null
      : dragData?.dropIndex === index
        ? index === value.length - 1
          ? dragData.isTop
          : dragData.isTop || null
        : (dragData?.dropIndex === index - 1 && dragData.isTop === false) || null
  }, [value, dragData, getSelectionRectIndexes])

  /* ---
    GET COMMON PROPS
    Get props shared by Block and BlockContent
  --- */
  const getCommonProps = useCallback((item: ReactBlockTextDataItem, index: number) => {
    const props: Omit<BlockCommonProps, 'readOnly'> = {
      item,
      index,
      pluginsData,
      focusContent: () => handleFocusContent(index),
      focusContentAtStart: () => handleFocusContent(index, true),
      focusContentAtEnd: () => handleFocusContent(index, false, true),
      focusNextContent: () => handleFocusContent(index + 1),
      blurContent: () => handleBlurContent(index),
      onRectSelectionMouseDown: handleRectSelectionStart,
    }

    return props
  }, [
    pluginsData,
    handleFocusContent,
    handleBlurContent,
    handleRectSelectionStart,
  ])

  /* ---
    GET BLOCK CONTENT PROPS
  --- */
  const getBlockContentProps = useCallback((item: ReactBlockTextDataItem, index: number) => {
    const props: BlockContentProps = {
      ...getCommonProps(item, index),
      editorState: editorStates[item.id],
      readOnly: isSelecting || !!readOnly,
      focused: !dragData && index === focusedIndex,
      placeholder: "Start typing or press '/' for commands",
      fallbackPlaceholder: '',
      isSelecting,
      registerRef: ref => registerRef(item.id, ref),
      onChange: editorState => handleChange(item.id, editorState),
      onReturn: event => handleReturn(index, event),
      onUpArrow: event => handleUpArrow(index, event),
      onDownArrow: event => handleDownArrow(index, event),
      onFocus: () => handleFocus(index),
      onBlur: handleBlur,
      onPaste: () => handlePaste(index),
      onKeyCommand: command => handleKeyCommand(index, command),
      onBlockSelection: () => handleSingleBlockSelection(item.id),
      forceBlurContent: () => handleForceBlurContent(index),
      BlockContentText,
    }

    return props
  }, [
    readOnly,
    focusedIndex,
    dragData,
    editorStates,
    getCommonProps,
    registerRef,
    handleChange,
    handleReturn,
    handleUpArrow,
    handleDownArrow,
    handleFocus,
    handleBlur,
    handlePaste,
    handleKeyCommand,
    handleSingleBlockSelection,
    handleForceBlurContent,
  ])

  const getBlockProps = useCallback((item: ReactBlockTextDataItem, index: number) => {
    const props: Omit<BlockProps, 'children'> = {
      ...getCommonProps(item, index),
      paddingLeft,
      paddingRight,
      readOnly: !!readOnly,
      selected: !!selectionRect?.selectedIds.includes(item.id),
      hovered: !dragData && index === hoveredIndex,
      isDraggingTop: getIsDraggingTop(index),
      registerSelectionRef: ref => registerSelectionRef(item.id, ref),
      onAddItem: () => handleAddItem(index),
      onDeleteItem: () => handleDeleteItem(index),
      onDuplicateItem: () => handleDuplicateItem(index),
      onMouseDown: handleBlockMouseDown,
      onMouseMove: () => !wasDragging && setHoveredIndex(index),
      onMouseLeave: () => !wasDragging && setHoveredIndex(previous => previous === index ? -1 : previous),
      onDragStart: () => handleDragStart(index),
      onDrag: handleDrag,
      onDragEnd: () => handleDragEnd(index),
      onBlockMenuOpen: () => setIsBlockMenuOpen(true),
      onBlockMenuClose: handleBlockMenuClose,
      // Pass block content props to block for drag preview display
      blockContentProps: getBlockContentProps(item, index),
    }

    return props
  }, [
    readOnly,
    paddingLeft,
    paddingRight,
    hoveredIndex,
    dragData,
    wasDragging,
    selectionRect,
    getCommonProps,
    getBlockContentProps,
    getIsDraggingTop,
    registerSelectionRef,
    handleAddItem,
    handleDeleteItem,
    handleDuplicateItem,
    handleDragStart,
    handleDrag,
    handleDragEnd,
    handleBlockMenuClose,
    handleBlockMouseDown,
  ])

  /* ---
    RENDER EDITOR
    Render the editor for each item of value
  --- */
  const renderEditor = useCallback((item: ReactBlockTextDataItem, index: number) => {
    if (!editorStates[item.id]) return null

    const plugin = pluginsData.find(plugin => plugin.type === item.type)

    if (!plugin) return null

    const { BlockContent } = plugin
    const blockProps = getBlockProps(item, index)

    return (
      <Block
        key={item.id}
        {...blockProps}
      >
        <BlockContent {...blockProps.blockContentProps} />
      </Block>
    )
  }, [
    pluginsData,
    editorStates,
    getBlockProps,
  ])

  /*
    SELECTED BLOCK PROPS
    For the drag layer to render a preview of the selected blocks on drag
  */
  const selectedBlockProps = useMemo(() => (
    getSelectionRectIndexes().map(index => getBlockProps(value[index], index))
  ), [value, getBlockProps, getSelectionRectIndexes])

  /*
    DRAG LAYER DRAG INDEX
    Among the selected blocks, the index of the block being dragged
  */
  const offsetDragIndex = useMemo(() => {
    const selectedIndexes = getSelectionRectIndexes()

    if (!selectedIndexes.length || !dragData) return 0

    return selectedIndexes.indexOf(dragData.dragIndex)
  }, [dragData, getSelectionRectIndexes])

  /* ---
    MAIN RETURN STATEMENT
  --- */
  return (
    <DndProvider backend={HTML5Backend}>
      <ColorsContext.Provider value={colorsContextValue}>
        <div
          ref={rootRef}
          onBlur={handleRootBlur}
          onMouseMove={handleRootMouseMove}
          onMouseLeave={handleRootMouseLeave}
          className={_('rbt-flex rbt-flex-col rbt-relative', className)}
          style={{
            // Prevent flickering of caret at the end of the line when switching blocks with arrow keys
            caretColor: isCaretVisible ? textColor : 'transparent',
            color: textColor,
            ...(style ?? {}),
          }}
        >
          <div
            onClick={() => handleFocusContent(0)}
            onMouseDown={handleRectSelectionStart}
            className="rbt-shrink-0 rbt-cursor-text"
            style={{ height: paddingTop || 0 }}
          />
          {value.map(renderEditor)}
          {!!queryMenuData && (
            <QueryMenu
              pluginsData={pluginsData}
              query={queryMenuData.query}
              top={queryMenuData.top}
              bottom={queryMenuData.bottom}
              left={queryMenuData.left}
              onClose={() => setQueryMenuData(null)}
              onSelect={handleContextMenuSelect}
            />
          )}
          {!!selectionRect?.isSelecting && (
            <SelectionRect
              top={selectionRect.top}
              left={selectionRect.left}
              width={selectionRect.width}
              height={selectionRect.height}
            />
          )}
          {!!(
            (selectionRect?.isSelecting && selectionRect.width && selectionRect.height)
            || isBlockMenuOpen
          ) && (
            <div className="rbt-absolute rbt-inset-0 rbt-z-10" />
          )}
          <div
            onClick={() => handleFocusContent(value.length - 1, false, true)}
            onMouseDown={handleRectSelectionStart}
            className="rbt-grow rbt-cursor-text"
            style={{ minHeight: paddingBottom || 0 }}
          />
          <div ref={injectionRef} />
        </div>
        <DragLayer
          pluginsData={pluginsData}
          blockProps={selectedBlockProps}
          dragIndex={offsetDragIndex}
        />
      </ColorsContext.Provider>
    </DndProvider>
  )
}

export default ReactBlockText
