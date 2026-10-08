import { GoogleGenAI } from "@google/genai";
import { Widget, CanvasSettings, CodeLanguage, AISettings, Screen, WidgetType, AIImageAttachment, WidgetStyle, WidgetFlags } from '../types';
import { DEVICE_PRESETS, getVisionSupport } from '../constants';

// ---------------------------------------------------------------------------
// Shared request plumbing
// ---------------------------------------------------------------------------

/** Anthropic-style image block (base64 source). */
interface AnthropicImageBlock {
  type: 'image';
  source: { type: 'base64'; media_type: string; data: string };
}

/** One block of an OpenAI-compatible multimodal user message. */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } };

/**
 * A provider-agnostic generation request. When `image` is set the model must be
 * multimodal — see `assertVisionSupported`.
 */
interface AIRequest {
  prompt: string;
  image?: AIImageAttachment | null;
  /** Ask the provider for a strict JSON object response (ignored where unsupported). */
  jsonMode?: boolean;
}

/** Output cap when the user has not configured one. Without this, long files get truncated. */
const DEFAULT_MAX_TOKENS = 8192;
/** Multimodal requests are much slower than text-only ones, so allow a generous window. */
const REQUEST_TIMEOUT_MS = 240_000;

const SYSTEM_PROMPT = 'You are an expert LVGL code generator. Output only code/JSON.';

const dataUrlToBase64 = (dataUrl: string): string => {
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
};

const stripCodeFences = (text: string): string =>
  text.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/```\s*$/, '').trim();

/**
 * Handle a response that was cut off by the output-token cap.
 * Code gets an inline marker (`//` is valid in C99 and MicroPython); JSON is unusable once
 * truncated, so it must fail loudly instead of surfacing a confusing parse error.
 */
const finalizeText = (text: string, truncated: boolean, jsonMode?: boolean): string => {
  if (!truncated) return text;
  if (jsonMode) {
    throw new Error(
      'The model was cut off by the output token limit before it finished the JSON. ' +
      'Raise "Max output tokens" in Settings, or simplify the mockup.'
    );
  }
  return `${text}\n// [truncated: the output token limit was reached. Increase "Max output tokens" in Settings.]`;
};

/**
 * Guard: refuse to attach an image to a model that is known to be text-only.
 * Unknown (custom/free-form) model ids are allowed through optimistically.
 */
const assertVisionSupported = (settings: AISettings, image?: AIImageAttachment | null): void => {
  if (!image) return;
  if (getVisionSupport(settings.provider, settings.model) === false) {
    const hint = settings.provider === 'deepseek'
      ? ' For DeepSeek, the vision model is "deepseek-flash" (DeepSeek V4.1 Flash).'
      : '';
    throw new Error(`Model "${settings.model}" does not accept image input.${hint}`);
  }
};

const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new Error(
        `The AI provider did not respond within ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s. ` +
        'Image requests are slower — try a smaller image, disable thinking mode, or raise Max output tokens.'
      );
    }
    throw new Error(
      `Could not reach the AI provider at ${url}. Check the Base URL and API key, and note that ` +
      'the provider must allow browser (CORS) requests. Original error: ' + (error as Error).message
    );
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const constructPrompt = (screens: Screen[], settings: CanvasSettings, language: CodeLanguage) => {
    // We send only necessary data to save tokens
    const projectData = {
        project: settings.projectName,
        width: settings.width,
        height: settings.height,
        theme: settings.theme,
        screens: screens.map(s => ({
            id: s.id,
            name: s.name,
            backgroundColor: s.backgroundColor,
            layers: s.layers.filter(l => l.visible).map(l => l.id), // Only visible layers
            widgets: s.widgets
                .filter(w => {
                    const layer = s.layers.find(l => l.id === w.layerId);
                    return layer && layer.visible;
                })
                .map(w => {
                    // Create a copy to remove heavy data
                    const { imageData, ...rest } = w;
                    return {
                        ...rest,
                        events: w.events // Include the events array
                    };
                })
        }))
    };

    // Find device name if set
    const selectedDevice = DEVICE_PRESETS.find(d => d.id === settings.targetDevice);
    const deviceName = selectedDevice ? `${selectedDevice.manufacturer} ${selectedDevice.name}` : 'Generic Custom Display';

    const projectJson = JSON.stringify(projectData, null, 2);

    return `
      You are an embedded GUI expert specializing in LVGL (Light and Versatile Graphics Library).
      
      Task: Generate production-ready ${language === 'c' ? 'C (LVGL v8/v9)' : 'MicroPython'} code for a multi-screen UI project.
      
      Target Hardware: ${deviceName}
      Display Dimensions: ${settings.width}x${settings.height}
      
      Project Data (JSON):
      ${projectJson}
      
      General Requirements:
      1. Output ONLY valid code. No markdown backticks (unless requested), no explanations.
      2. Support LVGL v8/v9 API standards.
      3. Global dimensions: ${settings.width}x${settings.height}.
      
      Specific ${language === 'c' ? 'C' : 'MicroPython'} Requirements:
      
      ${language === 'c' ? `
      - Include "lvgl/lvgl.h".
      - Declare global variables for all screen objects (e.g., \`lv_obj_t * ui_Screen1;\`) and widget objects so they are accessible.
      - Create a function \`void ui_init(void)\` that calls setup functions for all screens.
      - Create separate setup functions for each screen (e.g., \`void ui_Screen1_screen_init(void)\`).
      - In each screen setup:
        - Create the screen object.
        - Create all widgets.
      - Events:
        - For each widget event, generate a callback function (e.g., \`void ui_event_Button1(lv_event_t * e)\`).
        - Attach it using \`lv_obj_add_event_cb(widget, ui_event_Button1, LV_EVENT_..., NULL);\`.
        - Inside the callback:
          - If action is 'NAVIGATE', use \`lv_scr_load_anim(target_screen_obj, LV_SCR_LOAD_ANIM_FADE_ON, 500, 0, false);\`.
          - If action is 'CUSTOM_CODE', insert the code snippet directly.
      ` : `
      - Import \`lvgl as lv\`.
      - Assume \`lv.init()\` and display driver setup are done externally.
      - Create a class or global dictionary to hold screen objects.
      - Create a function \`ui_init()\` to build all screens.
      - Events:
        - Define a callback function for each event.
        - Attach using \`widget.add_event_cb(callback, lv.EVENT...., None)\`.
        - If action is 'NAVIGATE', use \`lv.scr_load_anim(...)\`.
        - If action is 'CUSTOM_CODE', insert the code snippet.
      `}

      Widget Styling & Parts Logic:
      - **Geometry**: Accurately apply x, y, width, height.
      - **Fonts**: Map 'style.fontSize' to the closest standard LVGL font (e.g., 14 -> \`lv_font_montserrat_14\`, 24 -> \`lv_font_montserrat_24\`).
      - **Flags Handling**:
        - The JSON widget object contains a \`flags\` object (e.g. \`{ checkable: true, floating: true }\`).
        - For each key in \`flags\` that is true, generate the corresponding LVGL flag add function:
          - \`hidden\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_HIDDEN)\`
          - \`clickable\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_CLICKABLE)\`
          - \`scrollable\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_SCROLLABLE)\`
          - \`checkable\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_CHECKABLE)\`
          - \`press_lock\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_PRESS_LOCK)\`
          - \`adv_hittest\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_ADV_HITTEST)\`
          - \`floating\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_FLOATING)\`
          - \`overflow_visible\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_OVERFLOW_VISIBLE)\`
          - \`scroll_elastic\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_SCROLL_ELASTIC)\`
          - \`scroll_momentum\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_SCROLL_MOMENTUM)\`
          - \`scroll_one\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_SCROLL_ONE)\`
          - \`ignore_layout\` -> \`lv_obj_add_flag(obj, LV_OBJ_FLAG_IGNORE_LAYOUT)\`
        - If a flag is explicitly false (and default is true for that widget type), remove it (e.g. \`lv_obj_remove_flag\`).

      - **Base Styles**: Apply 'style.backgroundColor', 'style.borderRadius', 'style.borderWidth', 'style.borderColor' (as border color), 'style.textColor'.
      - **Shadows**:
        - Apply \`style.shadowWidth\` -> \`lv_obj_set_style_shadow_width\`
        - Apply \`style.shadowSpread\` -> \`lv_obj_set_style_shadow_spread\`
        - Apply \`style.shadowColor\` -> \`lv_obj_set_style_shadow_color\`
        - Apply \`style.shadowOpacity\` -> \`lv_obj_set_style_shadow_opa\`
        - Apply \`style.shadowOffsetX/Y\` -> \`lv_obj_set_style_shadow_ofs_x/y\`
        4. **Color Wheel**:
           - Use \`lv_colorwheel_create\`.
      
      - **Specific Widget Logic**:
        - **lv_icon**: Create a Label and set text to the symbol name (e.g., \`LV_SYMBOL_HOME\`). Apply text color.
        - **lv_img**: Use \`lv_img_set_src(img_obj, "S:path/to/" + src_filename)\`.
        - **lv_btn**: 
           - If \`contentMode\` is 'icon', create a child Label with the symbol.
           - If \`contentMode\` is 'text', create a child Label with the text.
           - Center the label on the button.
        - **lv_list**:
           - Use \`lv_list_create\`.
           - The \`options\` property contains newline-separated items. Parse this string.
           - For each item, use \`lv_list_add_btn(list, LV_SYMBOL_FILE, "Item Text")\`. Default to FILE icon for now or generic.
        - **lv_table**:
           - Use \`lv_table_create\`.
           - The \`options\` property contains CSV data (lines separated by \\n, cells by comma).
           - Set row/col count based on data.
           - Iterate and use \`lv_table_set_cell_value(table, row, col, "Value")\`.
        - **lv_spinbox**:
           - Use \`lv_spinbox_create\`.
           - Set \`lv_spinbox_set_range\` using widget min/max.
           - Set \`lv_spinbox_set_value\`.
    `;
};

const constructWidgetPrompt = (description: string, hasImage: boolean) => {
    return `
    You are an expert UI generator.
    Task: Create a single LVGL widget configuration JSON based on this description: "${description}".
    ${hasImage ? 'An image is attached. Use it as the visual reference for the widget\'s shape, colors, proportions and labels.' : ''}
    
    Return ONLY a raw JSON object (no markdown, no backticks) matching this Typescript interface:
    
    interface WidgetPartial {
      type: string; 
      name: string; 
      width: number;
      height: number;
      text?: string; 
      value?: number; 
      checked?: boolean; 
      symbol?: string; 
      options?: string; 
      flags?: {
        hidden?: boolean;
        clickable?: boolean;
        checkable?: boolean;
        floating?: boolean;
        // ... other flags
      };
      style: {
        backgroundColor?: string; 
        textColor?: string;
        borderColor?: string;
        borderWidth?: number;
        borderRadius?: number;
        fontSize?: number;
        shadowSpread?: number;
        shadowWidth?: number;
      }
    }

    Rules:
    1. Infer the best 'type' based on the description. Valid types are: ${Object.values(WidgetType).join(', ')}.
    2. Suggest reasonable width/height dimensions.
    3. If color is described, set backgroundColor/textColor/borderColor in hex (e.g. #FF0000).
    4. If 'round' is mentioned for a button, set borderRadius to high value (e.g. 20 or 99).
    5. If it's a specific icon (like 'settings' or 'wifi'), set the 'symbol' property to the closest 'LV_SYMBOL_...' string.
    6. For 'list', populate 'options' with example items separated by newlines.
    7. For 'table', populate 'options' with CSV data (Header1,Header2\nRow1Col1,Row1Col2).
    `;
};

/** Shared block describing the widget JSON contract used by the mockup importer. */
const widgetSchemaReference = (settings: CanvasSettings, replaceExisting: boolean, description?: string) => `
    Canvas: ${settings.width}x${settings.height} px (origin is the top-left corner).
    ${description ? `Designer's notes (highest priority): "${description}"` : ''}

    Return a JSON OBJECT of the exact shape {"widgets": [ ... ]} — nothing else, no markdown fences.

    Every entry must match this TypeScript interface:

    interface WidgetPartial {
      type: string;          // REQUIRED, one of: ${Object.values(WidgetType).join(', ')}
      name: string;          // short unique identifier, e.g. "HeaderLabel"
      x: number;             // left edge in px, 0..${settings.width}
      y: number;             // top edge in px, 0..${settings.height}
      width: number;         // px
      height: number;        // px
      text?: string;         // label / button text, keep it short and match the mockup wording
      contentMode?: 'text' | 'icon';
      value?: number;        // slider / bar / arc / roller initial value
      checked?: boolean;     // switch / checkbox
      symbol?: string;       // e.g. "LV_SYMBOL_WIFI" for lv_icon or icon buttons
      options?: string;      // newline separated items (list/roller/dropdown), CSV (table)
      style?: {
        backgroundColor?: string;  // "#RRGGBB"
        textColor?: string;        // "#RRGGBB"
        borderColor?: string;      // "#RRGGBB"
        borderWidth?: number;
        borderRadius?: number;
        fontSize?: number;         // px
        padding?: number;
        shadowColor?: string;
        shadowWidth?: number;
        shadowSpread?: number;
        shadowOpacity?: number;
      };
    }

    Rules:
    1. Prefer native LVGL widgets: containers ("${WidgetType.CONTAINER}") for panels/cards, "${WidgetType.LABEL}" for text, "${WidgetType.BUTTON}" for buttons.
    2. Read every visible string out of the image and put it in "text" (or "options" for lists). Do not invent lorem ipsum.
    3. Measure positions and sizes from the image and scale them to ${settings.width}x${settings.height}. Widgets must not overlap unless the mockup shows overlap.
    4. Sample the real colors from the image into "style.backgroundColor" / "textColor" / "borderColor" as "#RRGGBB".
    5. Use "${WidgetType.IMAGE}" (with a "src" placeholder filename) for photos/graphics you cannot express as widgets.
    6. Never emit "events" — the user wires those up afterwards.
    7. ${replaceExisting ? 'The returned widgets REPLACE everything currently on the canvas, so describe the complete UI.' : 'The returned widgets are APPENDED to the existing canvas, so only return the new elements.'}
    8. Group related elements inside containers nested by z-order: emit parents before children.
    9. Keep the count practical (<= 60 widgets) and skip purely decorative pixels.
`;

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

const resolveGeminiKey = (settings: AISettings): string => {
    // `process.env.API_KEY` is substituted at build time by vite.config.ts `define`.
    // Calling it lazily means the same file also works when settings carry the key.
    try {
        return process.env.API_KEY || settings.apiKey;
    } catch {
        return settings.apiKey;
    }
};

// -- Gemini Implementation --
const generateGemini = async (request: AIRequest, settings: AISettings): Promise<string> => {
    const ai = new GoogleGenAI({ apiKey: resolveGeminiKey(settings) });

    const parts: any[] = [{ text: request.prompt }];
    if (request.image) {
        parts.push({
            inlineData: {
                mimeType: request.image.mimeType,
                data: dataUrlToBase64(request.image.dataUrl)
            }
        });
    }

    const response = await ai.models.generateContent({
        model: settings.model || 'gemini-2.5-flash',
        contents: [{ role: 'user', parts }],
        config: {
            maxOutputTokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(request.jsonMode ? { responseMimeType: 'application/json' } : {})
        }
    });
    return response.text?.trim() || "// No response generated.";
};

// -- OpenAI / Compatible Implementation --
// Handles OpenAI, DeepSeek, and Local LLMs (Ollama)
const generateOpenAICompatible = async (request: AIRequest, settings: AISettings): Promise<string> => {
    const key = settings.apiKey;
    const url = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (key) {
        headers['Authorization'] = `Bearer ${key}`;
    }

    const userContent: string | OpenAIContentPart[] = request.image
        ? [
            { type: 'text', text: request.prompt },
            {
                type: 'image_url',
                image_url: {
                    url: request.image.dataUrl,
                    // 'high' keeps small UI text legible; the image is already downscaled locally.
                    detail: 'high'
                }
            }
        ]
        : request.prompt;

    const body: Record<string, unknown> = {
        model: settings.model,
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent }
        ],
        max_tokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS
    };

    // DeepSeek V4.x runs in thinking mode by default (effort=high) and *silently ignores*
    // temperature while thinking is on. Only sampling params we know will be honoured are sent.
    if (settings.provider === 'deepseek') {
        const effort = settings.thinkingEffort ?? 'auto';
        if (effort === 'disabled') {
            body.thinking = { type: 'disabled' };
            body.temperature = 0.2;
        } else if (effort !== 'auto') {
            body.reasoning_effort = effort;
        }
    } else {
        body.temperature = 0.2;
    }

    if (request.jsonMode) {
        body.response_format = { type: 'json_object' };
    }

    const response = await fetchWithTimeout(`${url}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`AI Request Failed: ${response.status} ${err}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const content = choice?.message?.content;

    if (!content) {
        if (choice?.message?.reasoning_content) {
            throw new Error(
                'The model produced thinking output but no answer — the output limit was probably ' +
                'consumed by reasoning. Raise "Max output tokens" or set DeepSeek thinking mode to disabled.'
            );
        }
        throw new Error("Invalid response format from AI provider.");
    }

    const cleanContent = stripCodeFences(content);
    return finalizeText(cleanContent, choice?.finish_reason === 'length', request.jsonMode);
};

// -- Anthropic Implementation --
const generateAnthropic = async (request: AIRequest, settings: AISettings): Promise<string> => {
    const key = settings.apiKey;
    const url = (settings.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');

    const headers: Record<string, string> = {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        // Required for calling the Anthropic API straight from a browser tab.
        'anthropic-dangerous-direct-browser-access': 'true'
    };

    const content: Array<AnthropicImageBlock | { type: 'text'; text: string }> = [];
    if (request.image) {
        content.push({
            type: 'image',
            source: {
                type: 'base64',
                media_type: request.image.mimeType,
                data: dataUrlToBase64(request.image.dataUrl)
            }
        });
    }
    content.push({ type: 'text', text: request.prompt });

    const body = {
        model: settings.model,
        max_tokens: settings.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [{ role: "user", content }]
    };

    const response = await fetchWithTimeout(`${url}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Anthropic Request Failed: ${response.status} ${err}`);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text;

    if (!text) throw new Error("Invalid response format from Anthropic.");

    return finalizeText(stripCodeFences(text), data.stop_reason === 'max_tokens', request.jsonMode);
};

const runProvider = async (request: AIRequest, settings: AISettings): Promise<string> => {
    assertVisionSupported(settings, request.image);

    if (settings.provider === 'gemini') {
        return await generateGemini(request, settings);
    }
    if (settings.provider === 'anthropic') {
        return await generateAnthropic(request, settings);
    }
    // OpenAI, DeepSeek, Custom (Ollama)
    return await generateOpenAICompatible(request, settings);
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const generateLVGLCode = async (
    screens: Screen[],
    settings: CanvasSettings,
    language: CodeLanguage,
    aiSettings: AISettings
): Promise<string> => {
    try {
        const prompt = constructPrompt(screens, settings, language);
        return await runProvider({ prompt }, aiSettings);
    } catch (error) {
        console.error("Error generating code:", error);
        return `// Error generating code: ${(error as Error).message}\n// Please check your Settings (API Key/Provider).`;
    }
};

export interface MockupImportOptions {
    image: AIImageAttachment;
    language: CodeLanguage;
    /** Free-form guidance appended to the prompt. */
    description?: string;
    /** Fold the current canvas contents into the generated code as well. */
    includeProject?: boolean;
}

/**
 * Screenshot/mockup -> LVGL code. Throws on failure so the caller can surface the reason.
 */
export const generateCodeFromMockup = async (
    screens: Screen[],
    settings: CanvasSettings,
    aiSettings: AISettings,
    options: MockupImportOptions
): Promise<string> => {
    const { image, language, description, includeProject } = options;

    const selectedDevice = DEVICE_PRESETS.find(d => d.id === settings.targetDevice);
    const deviceName = selectedDevice ? `${selectedDevice.manufacturer} ${selectedDevice.name}` : 'Generic Custom Display';

    const basePrompt = constructPrompt(includeProject ? screens : [], settings, language);
    const projectSection = includeProject
        ? ''
        : `
      Ignore the existing (empty) project data above — the attached image is the ONLY source of truth.
    `;

    const prompt = `
      ${basePrompt}

      ================== VISION TASK ==================
      An image is attached: a UI mockup / screenshot of the target interface.

      Your job: reproduce that interface as production-ready ${language === 'c' ? 'C (LVGL v8/v9)' : 'MicroPython'} code.

      Target Hardware: ${deviceName}
      Canvas to match: ${settings.width}x${settings.height} px (scale the mockup layout to this grid)
      ${description ? `Designer's notes (highest priority): "${description}"` : ''}
      ${projectSection}
      Additional vision rules:
      1. Transcribe every visible string from the image — never invent placeholder text.
      2. Reproduce layout proportionally: positions and sizes must map to the ${settings.width}x${settings.height} grid.
      3. Sample the real colors from the image and apply them via the style setters.
      4. Use the widget that best matches each visual element (containers for panels, labels for text, buttons for tappables, sliders/bars/arcs for indicators).
      5. If the mockup contains several screens/pages, create one LVGL screen object per page.
      6. Output ONLY the code — no commentary, no markdown fences.
    `;

    return await runProvider({ prompt, image }, aiSettings);
};

// --- Widget JSON sanitisation -------------------------------------------------

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const VALID_TYPES: string[] = Object.values(WidgetType);

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
    const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
};

const safeString = (value: unknown, maxLength = 2000): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, maxLength) : undefined;
};

const STRING_STYLE_KEYS: Array<keyof WidgetStyle> = ['backgroundColor', 'textColor', 'borderColor', 'shadowColor', 'fontFamily'];
const NUMBER_STYLE_KEYS: Array<keyof WidgetStyle> = [
    'borderWidth', 'borderRadius', 'fontSize', 'opacity', 'padding',
    'shadowWidth', 'shadowSpread', 'shadowOpacity', 'shadowOffsetX', 'shadowOffsetY'
];
const FLAG_KEYS: Array<keyof WidgetFlags> = [
    'hidden', 'clickable', 'scrollable', 'checkable', 'press_lock', 'adv_hittest',
    'floating', 'ignore_layout', 'overflow_visible', 'scroll_elastic', 'scroll_momentum', 'scroll_one'
];

/** Keep only fields the editor understands, so malformed model output cannot corrupt state. */
const sanitizeStyle = (raw: unknown): WidgetStyle | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const source = raw as Record<string, unknown>;
    const style: WidgetStyle = {};

    for (const key of STRING_STYLE_KEYS) {
        const value = safeString(source[key], 40);
        if (value && (key === 'fontFamily' || HEX_COLOR.test(value))) {
            (style as Record<string, unknown>)[key] = value;
        }
    }
    for (const key of NUMBER_STYLE_KEYS) {
        if (source[key] !== undefined) {
            (style as Record<string, unknown>)[key] = clampNumber(source[key], 0, 999, 0);
        }
    }
    return Object.keys(style).length ? style : undefined;
};

const sanitizeFlags = (raw: unknown): WidgetFlags | undefined => {
    if (!raw || typeof raw !== 'object') return undefined;
    const source = raw as Record<string, unknown>;
    const flags: WidgetFlags = {};
    for (const key of FLAG_KEYS) {
        if (typeof source[key] === 'boolean') {
            (flags as Record<string, unknown>)[key] = source[key];
        }
    }
    return Object.keys(flags).length ? flags : undefined;
};

/**
 * Validate + clamp model-produced widget JSON.
 * Returns the widgets that are usable and reports how many entries were dropped.
 */
export const sanitizeWidgetPayload = (
    raw: unknown,
    settings: CanvasSettings
): { widgets: Partial<Widget>[]; dropped: number } => {
    const list = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object' && Array.isArray((raw as { widgets?: unknown }).widgets))
            ? (raw as { widgets: unknown[] }).widgets
            : [];

    if (!Array.isArray(list)) throw new Error('The model did not return a widget list.');

    const widgets: Partial<Widget>[] = [];
    let dropped = 0;

    list.slice(0, 80).forEach((entry, index) => {
        if (!entry || typeof entry !== 'object') { dropped++; return; }
        const item = entry as Record<string, unknown>;

        const type = typeof item.type === 'string' && VALID_TYPES.includes(item.type)
            ? (item.type as WidgetType)
            : undefined;
        if (!type) { dropped++; return; }

        const width = clampNumber(item.width, 4, settings.width, 100);
        const height = clampNumber(item.height, 4, settings.height, 40);

        const widget: Partial<Widget> = {
            type,
            name: safeString(item.name, 60) || `AI_${type.replace(/^lv_/, '')}_${index + 1}`,
            x: clampNumber(item.x, 0, Math.max(0, settings.width - width), 0),
            y: clampNumber(item.y, 0, Math.max(0, settings.height - height), 0),
            width,
            height
        };

        const text = safeString(item.text, 500);
        if (text !== undefined) widget.text = text;

        const symbol = safeString(item.symbol, 60);
        if (symbol !== undefined) widget.symbol = symbol;

        const options = safeString(item.options, 4000);
        if (options !== undefined) widget.options = options;

        const src = safeString(item.src, 200);
        if (src !== undefined) widget.src = src;

        const placeholder = safeString(item.placeholder, 200);
        if (placeholder !== undefined) widget.placeholder = placeholder;

        if (item.contentMode === 'text' || item.contentMode === 'icon') widget.contentMode = item.contentMode;
        if (item.chartType === 'line' || item.chartType === 'bar') widget.chartType = item.chartType;

        if (typeof item.value === 'number' && Number.isFinite(item.value)) widget.value = item.value;
        if (typeof item.checked === 'boolean') widget.checked = item.checked;
        if (typeof item.min === 'number' && Number.isFinite(item.min)) widget.min = item.min;
        if (typeof item.max === 'number' && Number.isFinite(item.max)) widget.max = item.max;

        const style = sanitizeStyle(item.style);
        if (style) widget.style = style;

        const flags = sanitizeFlags(item.flags);
        if (flags) widget.flags = flags;

        widgets.push(widget);
    });

    if (!widgets.length) {
        throw new Error('The model returned no usable widgets. Try a clearer mockup or add a short description.');
    }
    return { widgets, dropped };
};

export interface MockupWidgetOptions {
    image: AIImageAttachment;
    /** Free-form guidance appended to the prompt. */
    description?: string;
    /** True when the import replaces everything already on the canvas. */
    replaceExisting?: boolean;
}

export interface MockupWidgetResult {
    widgets: Partial<Widget>[];
    dropped: number;
}

/**
 * Screenshot/mockup -> widget list that can be dropped straight onto the canvas.
 */
export const generateWidgetsFromMockup = async (
    settings: CanvasSettings,
    aiSettings: AISettings,
    options: MockupWidgetOptions
): Promise<MockupWidgetResult> => {
    const { image, description, replaceExisting = false } = options;

    const prompt = `
      You are an expert UI reverse-engineer for LVGL embedded interfaces.

      An image is attached: a mockup / screenshot of a target user interface.
      Convert it into a widget list that recreates the UI in a drag-and-drop LVGL editor.

      ${widgetSchemaReference(settings, replaceExisting, description)}
    `;

    const raw = await runProvider({ prompt, image, jsonMode: true }, aiSettings);
    const cleaned = raw.replace(/```json/gi, '').replace(/```/g, '').trim();

    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch {
        // Some models wrap the array in prose; salvage the outermost JSON value.
        const start = cleaned.search(/[[{]/);
        const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'));
        if (start >= 0 && end > start) {
            try {
                parsed = JSON.parse(cleaned.slice(start, end + 1));
            } catch {
                throw new Error('The model returned malformed JSON for the mockup. Try again or add a short description.');
            }
        } else {
            throw new Error('The model returned malformed JSON for the mockup. Try again or add a short description.');
        }
    }

    return sanitizeWidgetPayload(parsed, settings);
};

export const generateSingleWidget = async (
    description: string,
    aiSettings: AISettings,
    image?: AIImageAttachment | null
): Promise<Partial<Widget>> => {
    try {
        const prompt = constructWidgetPrompt(description, !!image);
        const jsonStr = await runProvider({ prompt, image, jsonMode: true }, aiSettings);

        // Clean potentially leftover markdown
        const cleaned = jsonStr.replace(/```json/gi, '').replace(/```/g, '').trim();
        const comma = cleaned.indexOf('{');
        const end = cleaned.lastIndexOf('}');

        const widgetData = JSON.parse(comma >= 0 && end > comma ? cleaned.slice(comma, end + 1) : cleaned);
        return widgetData;
    } catch (error) {
        console.error("Error creating widget from AI:", error);
        throw error;
    }
};
