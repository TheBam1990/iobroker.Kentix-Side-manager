"use strict";

const http = require("http");
const https = require("https");
const utils = require("@iobroker/adapter-core");

const DEFAULT_ENDPOINTS = [
    "/api/v1/system",
    "/api/v1/status",
    "/api/v1/devices",
    "/api/v1/device",
    "/api/v1/sensors",
    "/api/v1/sensor",
    "/api/v1/inputs",
    "/api/v1/outputs",
    "/api/v1/alarms",
    "/api/v1/alarm",
    "/api/v1/security",
    "/api/v1/rooms",
    "/api/v1/doors",
    "/api/v1/access",
    "/api/system",
    "/api/status",
    "/api/devices",
    "/api/sensors",
    "/api/alarm",
    "/api/alarms",
    "/rest/system",
    "/rest/status",
    "/rest/devices",
    "/rest/sensors",
    "/rest/alarm",
];

const ALARM_COMMANDS = {
    arm: [
        { method: "PUT", path: "/api/v1/alarm/armed", body: { armed: true } },
        { method: "PUT", path: "/api/v1/alarm", body: { armed: true } },
        { method: "PUT", path: "/api/v1/security", body: { armed: true } },
        { method: "POST", path: "/api/v1/alarm/arm", body: {} },
        { method: "POST", path: "/api/v1/security/arm", body: {} },
        { method: "POST", path: "/api/alarm/arm", body: {} },
    ],
    disarm: [
        { method: "PUT", path: "/api/v1/alarm/armed", body: { armed: false } },
        { method: "PUT", path: "/api/v1/alarm", body: { armed: false } },
        { method: "PUT", path: "/api/v1/security", body: { armed: false } },
        { method: "POST", path: "/api/v1/alarm/disarm", body: {} },
        { method: "POST", path: "/api/v1/security/disarm", body: {} },
        { method: "POST", path: "/api/alarm/disarm", body: {} },
    ],
    partial: [
        { method: "PUT", path: "/api/v1/alarm", body: { mode: "partial" } },
        { method: "PUT", path: "/api/v1/security", body: { mode: "partial" } },
        { method: "POST", path: "/api/v1/alarm/partial", body: {} },
        { method: "POST", path: "/api/v1/security/partial", body: {} },
    ],
};

class KentixSiteManagerAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: "kentix-sitemanager",
        });

        this.pollTimer = null;
        this.stopping = false;
        this.endpointStates = new Map();
        this.activeEndpoints = [];
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
            username: String(this.config.username || ""),
            password: String(this.config.password || ""),
            apiToken: String(this.config.apiToken || ""),
            allowSelfSigned: this.config.allowSelfSigned !== false,
            endpoints: this.parseEndpointConfig(this.config.endpoints),
            rawResponses: this.config.rawResponses === true || this.config.rawResponses === "true",
        };
    }

    async onReady() {
        await this.initObjects();
        await this.subscribeStatesAsync("control.*");

        if (!this.cfg.enabled) {
            this.log.info("Communication is disabled");
            await this.setStateAsync("info.connection", false, true);
            return;
        }
        if (!this.cfg.host) {
            await this.setStateAsync("info.lastError", "No Kentix SiteManager IP configured", true);
            this.log.warn("No Kentix SiteManager IP configured");
            return;
        }

        await this.poll(true);
        this.pollTimer = this.setInterval(() => void this.poll(false), this.cfg.pollIntervalMs);
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
            if (rel === "control.armFull" && state.val === true) {
                await this.runAlarmCommand("arm");
                await this.setStateAsync("control.armFull", false, true);
                return;
            }
            if (rel === "control.disarm" && state.val === true) {
                await this.runAlarmCommand("disarm");
                await this.setStateAsync("control.disarm", false, true);
                return;
            }
            if (rel === "control.armPartial" && state.val === true) {
                await this.runAlarmCommand("partial");
                await this.setStateAsync("control.armPartial", false, true);
                return;
            }
            if (rel === "control.alarmArmed") {
                await this.runAlarmCommand(state.val === true ? "arm" : "disarm");
                return;
            }
            if (rel === "control.alarmMode") {
                const mode = String(state.val || "").toLowerCase();
                if (["arm", "armed", "full", "on", "scharf"].includes(mode)) {
                    await this.runAlarmCommand("arm");
                } else if (["partial", "part", "teil", "intern"].includes(mode)) {
                    await this.runAlarmCommand("partial");
                } else if (["disarm", "disarmed", "off", "unscharf"].includes(mode)) {
                    await this.runAlarmCommand("disarm");
                } else {
                    throw new Error(`Unknown alarm mode "${state.val}"`);
                }
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

        await this.ensureChannel("control", "Control");
        await this.ensureState("control.refresh", "Refresh now", "boolean", "button", false, true);
        await this.ensureState("control.alarmArmed", "Alarm armed", "boolean", "switch", false, true);
        await this.ensureState("control.alarmMode", "Alarm mode: arm, partial, disarm", "string", "text", false, true);
        await this.ensureState("control.armFull", "Arm alarm", "boolean", "button", false, true);
        await this.ensureState("control.armPartial", "Partially arm alarm", "boolean", "button", false, true);
        await this.ensureState("control.disarm", "Disarm alarm", "boolean", "button", false, true);

        await this.ensureChannel("api", "Kentix API data");
        await this.ensureChannel("raw", "Raw JSON responses");
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
            if (forceDiscover || this.activeEndpoints.length === 0) {
                await this.discoverEndpoints();
            }

            const results = {};
            for (const endpoint of this.activeEndpoints) {
                try {
                    const data = await this.request("GET", endpoint.path);
                    results[endpoint.path] = data;
                    await this.storeEndpoint(endpoint.path, data);
                } catch (error) {
                    this.log.debug(`Endpoint ${endpoint.path} failed: ${error.message}`);
                }
            }

            await this.setStateAsync("info.connection", true, true);
            await this.setStateAsync("info.lastError", "", true);
            await this.setStateAsync("info.lastUpdate", new Date().toISOString(), true);
            this.updateAlarmControlFromData(results);
        } catch (error) {
            await this.setStateAsync("info.connection", false, true);
            await this.setStateAsync("info.lastError", error.message, true);
            this.log.warn(`Poll failed: ${error.message}`);
        }
    }

    async discoverEndpoints() {
        const candidates = this.buildBaseCandidates();
        const endpoints = this.cfg.endpoints;
        const found = [];
        let selectedBase = "";
        let lastError = "";

        for (const base of candidates) {
            for (const path of endpoints) {
                try {
                    const data = await this.request("GET", path, undefined, base);
                    if (data !== undefined) {
                        found.push({ base, path });
                        selectedBase = base;
                    }
                } catch (error) {
                    lastError = error.message;
                }
            }
            if (found.length > 0) break;
        }

        if (found.length === 0) {
            throw new Error(`No usable Kentix API endpoint found. Last error: ${lastError}`);
        }

        this.baseUrl = selectedBase;
        this.activeEndpoints = found.map(item => ({ path: item.path }));
        await this.setStateAsync("info.baseUrl", selectedBase, true);
        await this.setStateAsync("info.activeEndpoints", JSON.stringify(this.activeEndpoints.map(e => e.path)), true);
        this.log.info(`Kentix API detected at ${selectedBase}; endpoints: ${this.activeEndpoints.map(e => e.path).join(", ")}`);
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
            };
            if (payload !== undefined) {
                headers["Content-Type"] = "application/json";
                headers["Content-Length"] = Buffer.byteLength(payload);
            }
            if (this.cfg.apiToken) {
                headers.Authorization = `Bearer ${this.cfg.apiToken}`;
            } else if (this.cfg.username || this.cfg.password) {
                headers.Authorization = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64")}`;
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
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        reject(new Error(`${method} ${path} HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                        return;
                    }
                    if (!text.trim()) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(text));
                    } catch {
                        reject(new Error(`${method} ${path} returned non-JSON response`));
                    }
                });
            });
            req.on("timeout", () => {
                req.destroy(new Error(`${method} ${path} timeout`));
            });
            req.on("error", reject);
            if (payload !== undefined) req.write(payload);
            req.end();
        });
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
            await this.ensureDynamicState(prefix, "value", "string", true);
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

    updateAlarmControlFromData(results) {
        const flattened = [];
        const visit = value => {
            if (Array.isArray(value)) {
                value.forEach(visit);
            } else if (this.isObject(value)) {
                for (const [key, child] of Object.entries(value)) {
                    const lk = key.toLowerCase();
                    if (lk.includes("armed") || lk.includes("alarm") || lk.includes("scharf") || lk.includes("mode")) {
                        flattened.push({ key: lk, value: child });
                    }
                    visit(child);
                }
            }
        };
        visit(results);

        for (const item of flattened) {
            if (typeof item.value === "boolean" && (item.key.includes("armed") || item.key.includes("scharf"))) {
                void this.setStateAsync("control.alarmArmed", item.value, true);
                return;
            }
            if (typeof item.value === "string") {
                const val = item.value.toLowerCase();
                if (["armed", "arm", "full", "on", "scharf"].includes(val)) {
                    void this.setStateAsync("control.alarmArmed", true, true);
                    void this.setStateAsync("control.alarmMode", "arm", true);
                    return;
                }
                if (["disarmed", "disarm", "off", "unscharf"].includes(val)) {
                    void this.setStateAsync("control.alarmArmed", false, true);
                    void this.setStateAsync("control.alarmMode", "disarm", true);
                    return;
                }
            }
        }
    }

    async runAlarmCommand(command) {
        const attempts = ALARM_COMMANDS[command] || [];
        let lastError = "";
        if (!this.baseUrl) {
            await this.discoverEndpoints();
        }
        for (const attempt of attempts) {
            try {
                await this.request(attempt.method, attempt.path, attempt.body);
                await this.setStateAsync("info.lastCommandError", "", true);
                await this.poll(true);
                this.log.info(`Kentix alarm command ${command} succeeded via ${attempt.method} ${attempt.path}`);
                return;
            } catch (error) {
                lastError = error.message;
                this.log.debug(`Alarm command ${command} failed via ${attempt.method} ${attempt.path}: ${error.message}`);
            }
        }
        throw new Error(`All ${command} command variants failed. Last error: ${lastError}`);
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
        await this.setObjectNotExistsAsync(id, {
            type: "channel",
            common: { name },
            native: {},
        });
        this.knownObjects.add(id);
    }

    async ensureState(id, name, type, role, read, write, unit = "") {
        if (this.knownObjects.has(id)) return;
        await this.setObjectNotExistsAsync(id, {
            type: "state",
            common: {
                name,
                type,
                role,
                read,
                write,
                unit,
            },
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
