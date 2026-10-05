// Free-model discovery is kept separate from the chat loop so it can be tested
// without Puter, the DOM, or an authenticated account. Never infer that a model
// is free merely because it is open-weight or has an unknown price: it must have
// an explicit `:free` marker or explicit zero input AND output pricing.
(function attachFreeModelDiscovery(root) {
    const PRICE_KEYS = [
        'input', 'output', 'prompt', 'completion',
        'input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens',
        'input_cost', 'output_cost', 'prompt_cost', 'completion_cost',
        'request', 'cached', 'cached_tokens', 'cache_read', 'cache_write',
        'input_cache_read', 'output_cache_read', 'input_cache_write', 'output_cache_write',
        'cache_read_input_tokens', 'cache_creation_input_tokens',
        'ephemeral_5m_input_tokens', 'ephemeral_1h_input_tokens', 'web_search',
    ];
    const ZERO_PRICE_PAIRS = [
        ['input', 'output'],
        ['prompt', 'completion'],
        ['input_tokens', 'output_tokens'],
        ['prompt_tokens', 'completion_tokens'],
        ['input_cost', 'output_cost'],
        ['prompt_cost', 'completion_cost'],
    ];

    function finitePrice(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string' && value.trim() !== '') {
            const parsed = Number(value);
            if (Number.isFinite(parsed)) return parsed;
        }
        return null;
    }

    function hasPositiveOrInvalidPrice(model) {
        const sources = [model.cost, model.costs, model.pricing];
        for (const source of sources) {
            if (!source || typeof source !== 'object') continue;
            for (const key of PRICE_KEYS) {
                if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
                const rawPrice = source[key];
                if (rawPrice == null) continue;
                const value = finitePrice(rawPrice);
                // A listed non-zero or malformed price means we cannot safely
                // promise that this variant is free.
                if (value === null || value !== 0) return true;
            }
        }
        return false;
    }

    function hasExplicitZeroInputAndOutput(model) {
        const sources = [model.cost, model.costs, model.pricing];
        return sources.some(source => source && typeof source === 'object'
            && ZERO_PRICE_PAIRS.some(([inputKey, outputKey]) =>
                finitePrice(source[inputKey]) === 0 && finitePrice(source[outputKey]) === 0));
    }

    function hasExplicitFreeMarker(model) {
        const id = String(model.id || '').trim();
        const name = String(model.name || '').trim();
        // `openrouter/free` is a free-model router; `:flex` and `:priority` are
        // deliberately not treated as free unless pricing explicitly says $0.
        return /(?:^|[/:])free$/i.test(id) || /\bfree\b/i.test(name);
    }

    function isFreeModel(model) {
        if (!model || typeof model !== 'object') return false;
        if (hasPositiveOrInvalidPrice(model)) return false;
        return hasExplicitFreeMarker(model) || hasExplicitZeroInputAndOutput(model);
    }

    function isUsableChatModel(model) {
        if (!model || typeof model !== 'object' || !String(model.id || '').trim()) return false;
        const saysFalse = value => value === false || value === 0 || String(value).toLowerCase() === 'false';
        const saysTrue = value => value === true || value === 1 || String(value).toLowerCase() === 'true';
        if (saysFalse(model.tool_call) || saysFalse(model.supports_tools)
            || saysFalse(model.supports_tool_call) || saysFalse(model.streaming)
            || saysFalse(model.supports_streaming)) return false;

        // Puter Builder sends streaming tool calls on every build turn. Reject
        // entries that explicitly advertise a non-chat or non-tool capability.
        if (saysFalse(model.chat) || saysFalse(model.supports_chat)
            || saysFalse(model.text_generation) || saysFalse(model.supports_text)) return false;
        if (model.capabilities && typeof model.capabilities === 'object') {
            if (saysFalse(model.capabilities.chat) || saysFalse(model.capabilities.text)) return false;
            if (Object.prototype.hasOwnProperty.call(model.capabilities, 'tools')
                && saysFalse(model.capabilities.tools)) return false;
            if (Object.prototype.hasOwnProperty.call(model.capabilities, 'streaming')
                && saysFalse(model.capabilities.streaming)) return false;
        }

        const input = model.modalities && model.modalities.input;
        if (Array.isArray(input) && !input.some(modality => String(modality).toLowerCase() === 'text')) return false;
        if (typeof input === 'string' && !/\\btext\\b/i.test(input)) return false;
        const output = model.modalities && model.modalities.output;
        if (Array.isArray(output) && !output.some(modality => /text/i.test(String(modality)))) return false;
        if (typeof output === 'string' && !/\\btext\\b/i.test(output)) return false;

        // If the provider explicitly says the model cannot use tools, it is not
        // a safe Builder candidate even when its pricing is free.
        if (model.tool_call != null && !saysTrue(model.tool_call)) return false;
        if (model.supports_tools != null && !saysTrue(model.supports_tools)) return false;
        if (model.supports_tool_call != null && !saysTrue(model.supports_tool_call)) return false;

        return isFreeModel(model);
    }

    function hasFreeVariantId(model) {
        return /(?:^|[/:])free$/i.test(String(model.id || '').trim());
    }

    function dateRank(model) {
        const timestamp = Date.parse(model.release_date || '');
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function numericRank(value) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : 0;
    }

    function compareModels(a, b) {
        // Prefer models explicitly marked as supporting tool calls, then free
        // variants with their own ID (rather than a generic zero-price listing),
        // then recent/high-context models. Unknown tool metadata is still
        // eligible, but ranks after an explicit `tool_call: true` entry.
        const toolRank = (m) => m.tool_call === true ? 0 : 1;
        const toolDifference = toolRank(a) - toolRank(b);
        if (toolDifference) return toolDifference;
        const variantDifference = Number(hasFreeVariantId(b)) - Number(hasFreeVariantId(a));
        if (variantDifference) return variantDifference;
        const dateDifference = dateRank(b) - dateRank(a);
        if (dateDifference) return dateDifference;
        const contextDifference = numericRank(b.context) - numericRank(a.context);
        if (contextDifference) return contextDifference;
        const outputDifference = numericRank(b.max_tokens) - numericRank(a.max_tokens);
        if (outputDifference) return outputDifference;
        return String(a.id).localeCompare(String(b.id));
    }

    function modelFamily(model) {
        // Provider-qualified IDs look like `infron:deepseek/model:free`. Strip
        // the serving route to diversify the three visible choices by model
        // family, not by gateway.
        const id = String(model.id || '').trim().toLowerCase()
            .replace(/^[a-z0-9._-]+:(?=[a-z0-9._-]+\/)/, '');
        const org = id.match(/^([^/:]+)\//);
        if (org) return org[1];

        const name = String(model.name || '').trim().toLowerCase();
        const namedFamily = name.match(/^([a-z][a-z0-9_-]*)/);
        if (namedFamily) return namedFamily[1].replace(/[0-9]+$/, '');
        const simpleId = id.replace(/:free$/i, '').split(':').pop();
        const prefix = simpleId.match(/^([a-z][a-z0-9_-]*?)(?:[0-9]|[-_.])/);
        return prefix ? prefix[1] : simpleId;
    }

    function unwrapModels(response) {
        if (Array.isArray(response)) return response;
        if (response && Array.isArray(response.models)) return response.models;
        return [];
    }

    function findFreeModels(response) {
        const seen = new Set();
        return unwrapModels(response)
            .filter(isUsableChatModel)
            .filter(model => {
                const id = String(model.id).trim();
                const key = id.toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .slice()
            .sort(compareModels);
    }

    function selectPrimary(models, limit = 3) {
        const max = Math.max(0, Math.min(3, Math.floor(Number(limit) || 0)));
        if (!max) return [];
        const sorted = (Array.isArray(models) ? models : [])
            .filter(isUsableChatModel)
            .slice()
            .sort(compareModels);
        const selected = [];
        const selectedIds = new Set();
        const selectedFamilies = new Set();

        // Show up to three different model families first. If fewer than three
        // families are actually free/available, fill the remaining slots with
        // the next best variants. The fallback code uses only this verified list.
        for (const model of sorted) {
            const id = String(model.id).trim().toLowerCase();
            const family = modelFamily(model);
            if (selectedIds.has(id) || !family || selectedFamilies.has(family)) continue;
            selected.push(model);
            selectedIds.add(id);
            selectedFamilies.add(family);
            if (selected.length >= max) return selected;
        }
        for (const model of sorted) {
            const id = String(model.id).trim().toLowerCase();
            if (selectedIds.has(id)) continue;
            selected.push(model);
            selectedIds.add(id);
            if (selected.length >= max) break;
        }
        return selected;
    }

    root.FreeModelDiscovery = Object.freeze({
        findFreeModels,
        hasExplicitZeroInputAndOutput,
        isFreeModel,
        isUsableChatModel,
        selectPrimary,
    });
})(window);
