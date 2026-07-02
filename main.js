"use strict";

const http = require("http");
const https = require("https");
const utils = require("@iobroker/adapter-core");

const DEFAULT_ENDPOINTS = [
    "/api/system/info",
    "/api/system",
    "/api/alarmgroups",
    "/api/armstategroups/names",
    "/api/log/alarm?per_page=10",
    "/api/state/sync",
    "/api/sitemanagers",
    "/api/multisensors",
    "/api/iomodules",
    "/api/alarmmanagers",
];

class KentixSiteManagerAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "kentix-sitemanager",
        });

        this.pollTimer = null;
        this.stopping = false;
        this.baseUrl = "";
        this.activeEndpoints = [];
        this.alarmGroupIds = new Set();
        this.alarmGroupObjectIds = new Map();
        this.knownObjects = new Set();

        this.on("ready", () => this.onReady());
        this.on("stateChange", (id, state) => this.onStateChange(id, state));
        this.on("unload", callback => this.onUnload(callback));
    }

    get cfg() {
        return {
            enabled: this.config.enabled !== false,
            host: String(this.config.host || "").trim(),
            protocol: String(this.config.protocol || "auto"),
            port: Number(this.config.port || 0),
            pollIntervalMs: Math.max(Number(this.config.pollIntervalMs || 15000), 5000),
            requestTimeoutMs: Math.max(Number(this.config.requestTimeoutMs || 7000), 1000),
            apiToken: String(this.config.apiToken || "").trim(),
            allowSelfSigned: this.config.allowSelfSigned !== false,
            rawResponses: this.config.rawResponses === true || this.config.rawResponses === "true",
            endpoints: this.parseEndpointConfig(this.config.endpoints),
            alarmGroupId: String(this.config.alarmGroupId || "").trim(),
        };
    }

    async onReady() {
        await this.initObjects();
        await this.subscribeStatesAsync("control.*");
        await this.subscribeStatesAsync("alarmgroups.*.control.*");

        if (!this.cfg.enabled) {
            this.log.info("Communication is disabled");
            await this.setStateAsync("info.connection", false, true);
            return;
        }
        if (!this.cfg.host) {
            await this.failStartup("No Kentix SiteManager IP configured");
            return;
        }
        if (!this.cfg.apiToken) {
            await this.failStartup("No Kentix SmartAPI bearer token configured");
            return;
        }

        await this.poll(true);
        this.pollTimer = this.setInterval(() => void this.poll(false), this.cfg.pollIntervalMs);
    }

    async failStartup(message) {
        await this.setStateAsync("info.connection", false, true);
        await this.setStateAsync("info.lastError", message, true);
        this.log.warn(message);
    }

    onUnload(callback) {
        this.stopping = true;
        try {
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    async onStateChange(id, state) {
        if (!state || state.ack) return;
        const prefix = `${this.namespace}.`;
        if (!id.startsWith(prefix)) return;
        const rel = id.slice(prefix.length);

        try {
            if (rel === "control.refresh" && state.val === true) {
                await this.poll(true);
                await this.setStateAsync("control.refresh", false, true);
                return;
            }

            if (rel === "control.armAll" && state.val === true) {
                await this.commandAllAlarmGroups("arm");
                await this.setStateAsync("control.armAll", false, true);
                return;
            }
            if (rel === "control.disarmAll" && state.val === true) {
                await this.commandAllAlarmGroups("disarm");
                await this.setStateAsync("control.disarmAll", false, true);
                return;
            }
            if (rel === "control.quitAll" && state.val === true) {
                await this.commandAllAlarmGroups("quit");
                await this.setStateAsync("control.quitAll", false, true);
                return;
            }

            const groupCommand = rel.match(/^alarmgroups\.([^.]*)\.control\.(arm|disarm|quit)$/);
            if (groupCommand && state.val === true) {
                const groupId = this.alarmGroupObjectIds.get(groupCommand[1]) || groupCommand[1];
                const command = groupCommand[2];
                await this.commandAlarmGroup(groupId, command);
                await this.setStateAsync(rel, false, true);
            }
        } catch (error) {
            await this.setStateAsync("info.lastCommandError", error.message, true);
            this.log.error(`Command failed: ${error.message}`);
        }
    }

    async initObjects() {
        await this.ensureChannel("info", "Information");
        await this.ensureState("info.connection", "Connection", "boolean", "indicator.connected", true, false);
        await this.ensureState("info.baseUrl", "Detected base URL", "string", "text", true, false);
        await this.ensureState("info.activeEndpoints", "Active API endpoints JSON", "string", "json", true, false);
        await this.ensureState("info.lastUpdate", "Last successful update", "string", "value.time", true, false);
        await this.ensureState("info.lastError", "Last error", "string", "text", true, false);
        await this.ensureState("info.lastCommandError", "Last command error", "string", "text", true, false);

        await this.ensureChannel("control", "Global control");
        await this.ensureState("control.refresh", "Refresh now", "boolean", "button", false, true);
        await this.ensureState("control.armAll", "Arm all discovered alarmgroups", "boolean", "button", false, true);
        await this.ensureState("control.disarmAll", "Disarm all discovered alarmgroups", "boolean", "button", false, true);
        await this.ensureState("control.quitAll", "Quit all discovered alarmgroups", "boolean", "button", false, true);

        await this.ensureChannel("api", "Kentix SmartAPI data");
        await this.ensureChannel("raw", "Raw JSON responses");
        await this.ensureChannel("alarmgroups", "Alarmgroups");
    }

    parseEndpointConfig(value) {
        if (!value) return DEFAULT_ENDPOINTS;
        if (Array.isArray(value)) return value.map(String).filter(Boolean);
        try {
            const parsed = JSON.parse(String(value));
            if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
        } catch {
            // fallback below
        }
        return String(value)
            .split(/\r?\n|,/)
            .map(item => item.trim())
            .filter(Boolean);
    }

    async poll(forceDiscover) {
        try {
            if (forceDiscover || !this.baseUrl) {
                await this.discoverBaseUrl();
            }

            const results = {};
            for (const path of this.activeEndpoints) {
                try {
                    const data = await this.request("GET", path);
                    results[path] = data;
                    await this.storeEndpoint(path, data);
                    if (path.startsWith("/api/alarmgroups")) {
                        await this.storeAlarmGroups(data);
                    }
                } catch (error) {
                    this.log.debug(`Endpoint ${path} failed: ${error.message}`);
                }
            }

            await this.setStateAsync("info.connection", true, true);
            await this.setStateAsync("info.lastError", "", true);
            await this.setStateAsync("info.lastUpdate", new Date().toISOString(), true);
        } catch (error) {
            await this.setStateAsync("info.connection", false, true);
            await this.setStateAsync("info.lastError", error.message, true);
            this.log.warn(`Poll failed: ${error.message}`);
        }
    }

    async discoverBaseUrl() {
        const candidates = this.buildBaseCandidates();
        let lastError = "";

        for (const base of candidates) {
            try {
                await this.request("GET", "/api/system/info", undefined, base);
                this.baseUrl = base;
                this.activeEndpoints = this.cfg.endpoints;
                await this.setStateAsync("info.baseUrl", base, true);
                await this.setStateAsync("info.activeEndpoints", JSON.stringify(this.activeEndpoints), true);
                this.log.info(`Kentix SmartAPI detected at ${base}`);
                return;
            } catch (error) {
                lastError = error.message;
            }
        }

        throw new Error(`Kentix SmartAPI not reachable. Last error: ${lastError}`);
    }

    buildBaseCandidates() {
        const cfg = this.cfg;
        const protocols = cfg.protocol === "auto" ? ["https", "http"] : [cfg.protocol];
        const result = [];
        for (const protocol of protocols) {
            const defaultPort = protocol === "https" ? 443 : 80;
            const port = cfg.port || defaultPort;
            const portPart = port === defaultPort ? "" : `:${port}`;
            result.push(`${protocol}://${cfg.host}${portPart}`);
        }
        return result;
    }

    request(method, path, body, baseUrl = this.baseUrl) {
        return new Promise((resolve, reject) => {
            if (!baseUrl) {
                reject(new Error("No base URL detected"));
                return;
            }

            const url = new URL(path, baseUrl);
            const isHttps = url.protocol === "https:";
            const payload = body === undefined ? undefined : JSON.stringify(body);
            const headers = {
                Accept: "application/json",
                Authorization: `Bearer ${this.cfg.apiToken}`,
            };
            if (payload !== undefined) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = Buffer.byteLength(payload);
            }

            const options = {
                method,
                hostname: url.hostname,
                port: url.port || (isHttps ? 443 : 80),
                path: `${url.pathname}${url.search}`,
                headers,
                timeout: this.cfg.requestTimeoutMs,
                rejectUnauthorized: !this.cfg.allowSelfSigned,
            };

            const transport = isHttps ? https : http;
            const req = transport.request(options, res => {
                const chunks = [];
                res.on("data", chunk => chunks.push(chunk));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    if (res.statusCode === 204) {
                        resolve({});
                        return;
                    }
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`${method} ${path} HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
                        return;
                    }
                    if (!text.trim()) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error(`${method} ${path} returned non-JSON response. Check Accept header/token.`));
                    }
                });
            });
            req.on("timeout", () => req.destroy(new Error(`${method} ${path} timeout`)));
            req.on("error", reject);
            if (payload !== undefined) req.write(payload);
            req.end();
        });
    }

    async storeAlarmGroups(data) {
        const groups = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : [];
        for (const group of groups) {
            if (!group || group.id === undefined || group.id === null) continue;
            const id = String(group.id);
            const objectId = this.safeId(id);
            this.alarmGroupIds.add(id);
            this.alarmGroupObjectIds.set(objectId, id);
            const base = `alarmgroups.${objectId}`;
            await this.ensureChannel(base, group.name || `Alarmgroup ${id}`);
            await this.ensureState(`${base}.id`, "ID", "string", "text", true, false);
            await this.ensureState(`${base}.name`, "Name", "string", "text", true, false);
            await this.ensureState(`${base}.rawJson`, "Raw JSON", "string", "json", true, false);
            await this.ensureChannel(`${base}.control`, "Control");
            await this.ensureState(`${base}.control.arm`, "Arm alarmgroup", "boolean", "button", false, true);
            await this.ensureState(`${base}.control.disarm`, "Disarm alarmgroup", "boolean", "button", false, true);
            await this.ensureState(`${base}.control.quit`, "Quit alarmgroup", "boolean", "button", false, true);
            await this.setStateAsync(`${base}.id`, id, true);
            await this.setStateAsync(`${base}.name`, group.name || "", true);
            await this.setStateAsync(`${base}.rawJson`, JSON.stringify(group), true);
        }
    }

    async commandAllAlarmGroups(command) {
        const ids = new Set(this.alarmGroupIds);
        if (this.cfg.alarmGroupId) {
            this.cfg.alarmGroupId.split(/[,\s]+/).filter(Boolean).forEach(id => ids.add(id));
        }
        if (ids.size === 0) {
            await this.poll(true);
        }
        const finalIds = new Set(this.alarmGroupIds);
        if (this.cfg.alarmGroupId) {
            this.cfg.alarmGroupId.split(/[,\s]+/).filter(Boolean).forEach(id => finalIds.add(id));
        }
        if (finalIds.size === 0) throw new Error("No alarmgroups discovered/configured");
        for (const id of finalIds) {
            await this.commandAlarmGroup(id, command);
        }
    }

    async commandAlarmGroup(groupId, command) {
        if (!this.baseUrl) await this.discoverBaseUrl();
        const id = encodeURIComponent(String(groupId));
        const path = `/api/alarmgroups/${id}/${command}`;
        await this.request("PUT", path);
        await this.setStateAsync("info.lastCommandError", "", true);
        this.log.info(`Kentix alarmgroup ${groupId}: ${command} succeeded`);
        await this.poll(false);
    }

    async storeEndpoint(path, data) {
        const baseId = `api.${this.safeId(path.replace(/^\/+/, "") || "root")}`;
        await this.ensureChannel(baseId, path);
        if (this.cfg.rawResponses) {
            await this.ensureState(`raw.${this.safeId(path)}`, `Raw ${path}`, "string", "json", true, false);
            await this.setStateAsync(`raw.${this.safeId(path)}`, JSON.stringify(data), true);
        }
        await this.flattenToStates(baseId, data);
    }

    async flattenToStates(prefix, value) {
        if (value === null || value === undefined) {
            await this.ensureDynamicState(prefix, "Value", "string", true);
            await this.setStateAsync(prefix, "", true);
            return;
        }
        if (Array.isArray(value)) {
            await this.ensureState(`${prefix}._count`, "Count", "number", "value", true, false);
            await this.setStateAsync(`${prefix}._count`, value.length, true);
            for (let i = 0; i < value.length; i++) {
                const child = `${prefix}.${this.arrayItemId(value[i], i)}`;
                if (this.isObject(value[i])) {
                    await this.ensureChannel(child, `Item ${i + 1}`);
                    await this.flattenToStates(child, value[i]);
                } else {
                    await this.ensureDynamicState(child, `Item ${i + 1}`, typeof value[i], true);
                    await this.setStateAsync(child, value[i], true);
                }
            }
            return;
        }
        if (this.isObject(value)) {
            for (const [key, childValue] of Object.entries(value)) {
                const child = `${prefix}.${this.safeId(key)}`;
                if (this.isObject(childValue) || Array.isArray(childValue)) {
                    await this.ensureChannel(child, key);
                    await this.flattenToStates(child, childValue);
                } else {
                    await this.ensureDynamicState(child, key, typeof childValue, true);
                    await this.setStateAsync(child, this.normalizeStateValue(childValue), true);
                }
            }
            return;
        }
        await this.ensureDynamicState(prefix, "Value", typeof value, true);
        await this.setStateAsync(prefix, this.normalizeStateValue(value), true);
    }

    isObject(value) {
        return value !== null && typeof value === "object" && !Array.isArray(value);
    }

    normalizeStateValue(value) {
        if (value === null || value === undefined) return "";
        if (typeof value === "object") return JSON.stringify(value);
        return value;
    }

    arrayItemId(value, index) {
        if (this.isObject(value)) {
            for (const key of ["id", "uuid", "uid", "name", "serial", "serialNumber", "mac", "address"]) {
                if (value[key] !== undefined && value[key] !== null && String(value[key]).trim()) {
                    return `${String(index + 1).padStart(3, "0")}_${this.safeId(String(value[key]))}`;
                }
            }
        }
        return String(index + 1).padStart(3, "0");
    }

    safeId(value) {
        const id = String(value)
            .replace(/^\/+|\/+$/g, "")
            .replace(/[^A-Za-z0-9_]+/g, "_")
            .replace(/^_+|_+$/g, "")
            .slice(0, 80);
        return id || "value";
    }

    async ensureChannel(id, name) {
        if (this.knownObjects.has(id)) return;
        await this.setObjectNotExistsAsync(id, { type: "channel", common: { name }, native: {} });
        this.knownObjects.add(id);
    }

    async ensureState(id, name, type, role, read, write, unit = "") {
        if (this.knownObjects.has(id)) return;
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: { name, type, role, read, write, unit },
            native: {},
        });
        this.knownObjects.add(id);
    }

    async ensureDynamicState(id, name, jsType, read) {
        const type = jsType === "boolean" ? "boolean" : jsType === "number" ? "number" : "string";
        const role = type === "boolean" ? "indicator" : type === "number" ? "value" : "text";
        await this.ensureState(id, name, type, role, read, false);
    }
}

if (require.main !== module) {
    module.exports = options => new KentixSiteManagerAdapter(options);
} else {
    new KentixSiteManagerAdapter();
}
