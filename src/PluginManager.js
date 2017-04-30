"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : new P(function (resolve) { resolve(result.value); }).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require("./fileSystem");
const path = require("path");
const NpmRegistryClient_1 = require("./NpmRegistryClient");
const PluginVm_1 = require("./PluginVm");
const lockFile = require("lockfile");
const semver = require("semver");
const Debug = require("debug");
const debug = Debug("live-plugin-manager");
const BASE_NPM_URL = "https://registry.npmjs.org";
const cwd = process.cwd();
const DefaultOptions = {
    npmRegistryUrl: BASE_NPM_URL,
    sandbox: {},
    npmRegistryConfig: {},
    pluginsPath: path.join(cwd, "plugins"),
    requireCoreModules: true,
    hostRequire: require,
    ignoredDependencies: [/^@types\//]
};
const NPM_LATEST_TAG = "latest";
class PluginManager {
    constructor(options) {
        this.installedPlugins = new Array();
        this.options = Object.assign({}, DefaultOptions, options || {});
        this.vm = new PluginVm_1.PluginVm(this);
        this.npmRegistry = new NpmRegistryClient_1.NpmRegistryClient(this.options.npmRegistryUrl, this.options.npmRegistryConfig);
    }
    installFromNpm(name, version = NPM_LATEST_TAG) {
        return __awaiter(this, void 0, void 0, function* () {
            yield fs.ensureDir(this.options.pluginsPath);
            yield this.syncLock();
            try {
                return yield this.installFromNpmLockFree(name, version);
            }
            finally {
                yield this.syncUnlock();
            }
        });
    }
    installFromPath(location) {
        return __awaiter(this, void 0, void 0, function* () {
            yield fs.ensureDir(this.options.pluginsPath);
            yield this.syncLock();
            try {
                return yield this.installFromPathLockFree(location);
            }
            finally {
                yield this.syncUnlock();
            }
        });
    }
    uninstall(name) {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.syncLock();
            try {
                return yield this.uninstallLockFree(name);
            }
            finally {
                yield this.syncUnlock();
            }
        });
    }
    uninstallAll() {
        return __awaiter(this, void 0, void 0, function* () {
            yield this.syncLock();
            try {
                // TODO First I should install dependents plugins??
                for (const plugin of this.installedPlugins.slice().reverse()) {
                    yield this.uninstallLockFree(plugin.name);
                }
            }
            finally {
                yield this.syncUnlock();
            }
        });
    }
    list() {
        return this.installedPlugins.map((p) => p);
    }
    require(name) {
        const info = this.getFullInfo(name);
        if (!info) {
            throw new Error(`${name} not installed`);
        }
        if (!info.loaded) {
            this.load(info);
        }
        return info.instance;
    }
    alreadyInstalled(name, version) {
        const installedInfo = this.getInfo(name);
        if (installedInfo) {
            if (!version) {
                return installedInfo;
            }
            if (semver.satisfies(installedInfo.version, version)) {
                return installedInfo;
            }
        }
        return undefined;
    }
    getInfo(name) {
        return this.getFullInfo(name);
    }
    getInfoFromNpm(name, version = NPM_LATEST_TAG) {
        return __awaiter(this, void 0, void 0, function* () {
            return yield this.npmRegistry.get(name, version);
        });
    }
    runScript(code) {
        return this.vm.runScript(code);
    }
    getFullInfo(name) {
        return this.installedPlugins.find((p) => p.name === name);
    }
    uninstallLockFree(name) {
        return __awaiter(this, void 0, void 0, function* () {
            debug(`Uninstalling ${name}...`);
            const info = this.getFullInfo(name);
            if (!info) {
                debug(`${name} not installed`);
                return;
            }
            yield this.deleteAndUnloadPlugin(info);
        });
    }
    installFromPathLockFree(location) {
        return __awaiter(this, void 0, void 0, function* () {
            const packageJson = yield this.readPackageJsonFromPath(location);
            // already installed satisfied version
            const installedInfo = this.alreadyInstalled(packageJson.name, packageJson.version);
            if (installedInfo) {
                return installedInfo;
            }
            // already installed not satisfied version
            if (this.alreadyInstalled(packageJson.name)) {
                yield this.uninstallLockFree(packageJson.name);
            }
            // already downloaded
            if (!(yield this.isAlreadyDownloaded(packageJson.name, packageJson.version))) {
                yield this.removeDownloaded(packageJson.name);
                debug(`Copy from ${location} to ${this.options.pluginsPath}`);
                yield fs.copy(location, this.getPluginLocation(packageJson.name));
            }
            return yield this.addPlugin(packageJson);
        });
    }
    installFromNpmLockFree(name, version = NPM_LATEST_TAG) {
        return __awaiter(this, void 0, void 0, function* () {
            const registryInfo = yield this.npmRegistry.get(name, version);
            // already installed satisfied version
            const installedInfo = this.alreadyInstalled(registryInfo.name, registryInfo.version);
            if (installedInfo) {
                return installedInfo;
            }
            // already installed not satisfied version
            if (this.alreadyInstalled(registryInfo.name)) {
                yield this.uninstallLockFree(registryInfo.name);
            }
            // already downloaded
            if (!(yield this.isAlreadyDownloaded(registryInfo.name, registryInfo.version))) {
                yield this.removeDownloaded(registryInfo.name);
                yield this.npmRegistry.download(this.options.pluginsPath, registryInfo);
            }
            return yield this.addPlugin(registryInfo);
        });
    }
    installDependencies(packageInfo) {
        return __awaiter(this, void 0, void 0, function* () {
            if (!packageInfo.dependencies) {
                return [];
            }
            const dependencies = new Array();
            for (const key in packageInfo.dependencies) {
                if (this.shouldIgnore(key)) {
                    continue;
                }
                if (packageInfo.dependencies.hasOwnProperty(key)) {
                    const version = packageInfo.dependencies[key].toString();
                    if (this.isModuleAvailableFromHost(key)) {
                        debug(`Installing dependencies of ${packageInfo.name}: ${key} is already available on host`);
                    }
                    else if (this.alreadyInstalled(key, version)) {
                        debug(`Installing dependencies of ${packageInfo.name}: ${key} is already installed`);
                    }
                    else {
                        debug(`Installing dependencies of ${packageInfo.name}: ${key} ...`);
                        yield this.installFromNpmLockFree(key, version);
                    }
                    dependencies.push(key);
                }
            }
            return dependencies;
        });
    }
    unloadWithDependents(plugin) {
        this.unload(plugin);
        for (const dependent of this.installedPlugins) {
            if (dependent.dependencies.indexOf(plugin.name) >= 0) {
                this.unloadWithDependents(dependent);
            }
        }
    }
    isModuleAvailableFromHost(name) {
        if (!this.options.hostRequire) {
            return false;
        }
        try {
            this.options.hostRequire.resolve(name);
            return true;
        }
        catch (e) {
            return false;
        }
    }
    getPluginLocation(name) {
        const safeName = name.replace("/", path.sep).replace("\\", path.sep);
        return path.join(this.options.pluginsPath, name);
    }
    removeDownloaded(name) {
        return __awaiter(this, void 0, void 0, function* () {
            const location = this.getPluginLocation(name);
            if (!(yield fs.exists(location))) {
                yield fs.remove(location);
            }
        });
    }
    isAlreadyDownloaded(name, version) {
        return __awaiter(this, void 0, void 0, function* () {
            const location = this.getPluginLocation(name);
            if (!(yield fs.exists(location))) {
                return false;
            }
            try {
                const packageJson = yield this.readPackageJsonFromPath(location);
                return (packageJson.name === name && packageJson.version === version);
            }
            catch (e) {
                return false;
            }
        });
    }
    readPackageJsonFromPath(location) {
        return __awaiter(this, void 0, void 0, function* () {
            const packageJsonFile = path.join(location, "package.json");
            if (!(yield fs.exists(packageJsonFile))) {
                throw new Error(`Invalid plugin ${location}, package.json is missing`);
            }
            const packageJson = JSON.parse(yield fs.readFile(packageJsonFile, "utf8"));
            if (!packageJson.name
                || !packageJson.version) {
                throw new Error(`Invalid plugin ${location}, 'main', 'name' and 'version' properties are required in package.json`);
            }
            return packageJson;
        });
    }
    load(plugin) {
        debug(`Loading ${plugin.name}...`);
        plugin.instance = this.vm.load(plugin, plugin.mainFile);
        plugin.loaded = true;
    }
    unload(plugin) {
        debug(`Unloading ${plugin.name}...`);
        plugin.loaded = false;
        plugin.instance = undefined;
        this.vm.unload(plugin);
    }
    addPlugin(packageInfo) {
        return __awaiter(this, void 0, void 0, function* () {
            const dependencies = yield this.installDependencies(packageInfo);
            const DefaultMainFile = "index.js";
            const DefaultMainFileExtension = ".js";
            const location = this.getPluginLocation(packageInfo.name);
            const pluginInfo = {
                name: packageInfo.name,
                version: packageInfo.version,
                location,
                mainFile: path.normalize(path.join(location, packageInfo.main || DefaultMainFile)),
                loaded: false,
                dependencies
            };
            // If no extensions for main file is used, just default to .js
            if (!path.extname(pluginInfo.mainFile)) {
                pluginInfo.mainFile += DefaultMainFileExtension;
            }
            this.installedPlugins.push(pluginInfo);
            return pluginInfo;
        });
    }
    deleteAndUnloadPlugin(plugin) {
        return __awaiter(this, void 0, void 0, function* () {
            const index = this.installedPlugins.indexOf(plugin);
            if (index >= 0) {
                this.installedPlugins.splice(index, 1);
            }
            this.unloadWithDependents(plugin);
            yield fs.remove(plugin.location);
        });
    }
    syncLock() {
        debug("Acquiring lock ...");
        const lockLocation = path.join(this.options.pluginsPath, "install.lock");
        return new Promise((resolve, reject) => {
            lockFile.lock(lockLocation, { wait: 30000 }, (err) => {
                if (err) {
                    debug("Failed to acquire lock", err);
                    return reject("Failed to acquire lock");
                }
                resolve();
            });
        });
    }
    syncUnlock() {
        debug("Releasing lock ...");
        const lockLocation = path.join(this.options.pluginsPath, "install.lock");
        return new Promise((resolve, reject) => {
            lockFile.unlock(lockLocation, (err) => {
                if (err) {
                    debug("Failed to release lock", err);
                    return reject("Failed to release lock");
                }
                resolve();
            });
        });
    }
    shouldIgnore(name) {
        for (const p of this.options.ignoredDependencies) {
            if (p instanceof RegExp) {
                return p.test(name);
            }
            return new RegExp(p).test(name);
        }
        return false;
    }
}
exports.PluginManager = PluginManager;
//# sourceMappingURL=PluginManager.js.map