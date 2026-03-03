/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

'use strict';

const utils       = require('@iobroker/adapter-core');
const HASS        = require('./lib/hass');
const adapterName = require('./package.json').name.split('.').pop();

let connected = false;
let hass;
let adapter;
const hassObjects = {};
let delayTimeout = null;
let stopped = false;
let whitelistRegex = [];
let blacklistRegex = [];
let labelWhitelistRegex = [];
let labelBlacklistRegex = [];
let lastAllEntitiesJson = null;
let entityLabelsById = {};
let allowedEntityIds = new Set();

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName, unload: stop});
    adapter = new utils.Adapter(options);

    // is called if a subscribed state changes
    adapter.on('stateChange', (id, state) => {
        // you can use the ack flag to detect if it is status (true) or command (false)
        if (state && !state.ack) {
            if (!connected) {
                return adapter.log.warn(`Cannot send command to "${id}", because not connected`);
            }
            /*if (id === adapter.namespace + '.' + '.info.resync') {
                queue.push({command: 'resync'});
                processQueue();
            } else */
            if (hassObjects[id]) {
                if (!hassObjects[id].common.write) {
                    adapter.log.warn(`Object ${id} is not writable!`);
                } else {
                    const serviceData = {};
                    const fields = hassObjects[id].native.fields;
                    const target = {};

                    let requestFields = {};
                    if (typeof state.val === 'string') {
                        state.val = state.val.trim();
                        if (state.val.startsWith('{') && state.val.endsWith('}')) {
                            try {
                                requestFields = JSON.parse(state.val) || {};
                            } catch (err) {
                                adapter.log.info(`Ignore data for service call ${id} is no valid JSON: ${err.message}`);
                                requestFields = {};
                            }
                        }
                    }

                    // If a non-JSON value was set, and we only have one relevant field, use this field as value
                    if (fields && Object.keys(requestFields).length === 0) {
                        const fieldList = Object.keys(fields);
                        if (fieldList.length === 1 && fieldList[0] !== 'entity_id') {
                            requestFields[fieldList[0]] = state.val;
                        } else if (fieldList.length === 2 && fields.entity_id) {
                            requestFields[fieldList[1 - fields.indexOf('entity_id')]] = state.val;
                        }
                    }

                    adapter.log.debug(`Prepare service call for ${id} with (mapped) request parameters ${JSON.stringify(requestFields)} from value: ${JSON.stringify(state.val)}`);
                    if (fields) {
                        for (const field in fields) {
                            if (!fields.hasOwnProperty(field)) {
                                continue;
                            }

                            if (field === 'entity_id') {
                                target.entity_id = hassObjects[id].native.entity_id
                            } else if (requestFields[field] !== undefined) {
                                serviceData[field] = requestFields[field];
                            }
                        }
                    }
                    const noFields = Object.keys(serviceData).length === 0;
                    serviceData.entity_id = hassObjects[id].native.entity_id

                    adapter.log.debug(`Send to HASS for service ${hassObjects[id].native.attr} with ${hassObjects[id].native.domain || hassObjects[id].native.type} and data ${JSON.stringify(serviceData)}`)
                    hass.callService(hassObjects[id].native.attr, hassObjects[id].native.domain || hassObjects[id].native.type, serviceData, target, err => {
                        err && adapter.log.error(`Cannot control ${id}: ${err}`);
                        if (err && fields && noFields) {
                            adapter.log.warn(`Please make sure to provide a stringified JSON as value to set relevant fields! Please refer to the Readme for details!`);
                            adapter.log.warn(`Allowed field keys are: ${Object.keys(fields).join(', ')}`);
                        }
                    });
                }
            }
        }
    });

    // is called when databases are connected and adapter received configuration.
    // start here!
    adapter.on('ready', main);

    return adapter;
}

function stop(callback) {
    stopped = true;
    delayTimeout && clearTimeout(delayTimeout);
    hass && hass.close();
    callback && callback();
}

function getUnit(name) {
    name = name.toLowerCase();
    if (name.indexOf('temperature') !== -1) {
        return '°C';
    } else if (name.indexOf('humidity') !== -1) {
        return '%';
    } else if (name.indexOf('pressure') !== -1) {
        return 'hPa';
    } else if (name.indexOf('degrees') !== -1) {
        return '°';
    } else if (name.indexOf('speed') !== -1) {
        return 'kmh';
    }
    return undefined;
}

function syncStates(states, cb) {
    if (!states || !states.length) {
        return cb();
    }
    const state = states.shift();
    const id = state.id;
    delete state.id;

    adapter.setForeignState(id, state, err => {
        err && adapter.log.error(err);
        setImmediate(syncStates, states, cb);
    });
}

function splitRegexList(value) {
    if (!value) {
        return [];
    }
    return String(value)
        .split(/\r?\n|[,;]/)
        .map(entry => entry.trim())
        .filter(entry => !!entry);
}

function compileRegexList(value, configName) {
    const entries = splitRegexList(value);
    const regexList = [];

    for (let i = 0; i < entries.length; i++) {
        try {
            regexList.push(new RegExp(entries[i]));
        } catch (err) {
            adapter.log.warn(`Invalid ${configName} regex "${entries[i]}": ${err.message}`);
        }
    }

    return regexList;
}

function updateEntityFilters() {
    whitelistRegex = compileRegexList(adapter.config.whitelist, 'whitelist');
    blacklistRegex = compileRegexList(adapter.config.blacklist, 'blacklist');
    labelWhitelistRegex = compileRegexList(adapter.config.labelWhitelist, 'labelWhitelist');
    labelBlacklistRegex = compileRegexList(adapter.config.labelBlacklist, 'labelBlacklist');

    adapter.log.info(`Entity sync filter active (whitelist=${whitelistRegex.length}, blacklist=${blacklistRegex.length}, labelWhitelist=${labelWhitelistRegex.length}, labelBlacklist=${labelBlacklistRegex.length})`);
}

function isEntityAllowedByName(entityId) {
    const allowByWhitelist = whitelistRegex.length === 0 || whitelistRegex.some(regex => regex.test(entityId));
    if (!allowByWhitelist) {
        return false;
    }
    return !blacklistRegex.some(regex => regex.test(entityId));
}

function isEntityAllowedByLabel(entityId) {
    const labels = entityLabelsById[entityId] || [];
    const allowByLabelWhitelist = labelWhitelistRegex.length === 0 || labels.some(label => labelWhitelistRegex.some(regex => regex.test(label)));
    if (!allowByLabelWhitelist) {
        return false;
    }
    return !labels.some(label => labelBlacklistRegex.some(regex => regex.test(label)));
}

function isEntityAllowed(entityId) {
    return isEntityAllowedByName(entityId) && isEntityAllowedByLabel(entityId);
}

function shouldFetchLabelRegistryData() {
    return !!(labelWhitelistRegex.length || labelBlacklistRegex.length);
}

function getStringArray(values) {
    if (!values) {
        return [];
    }
    if (Array.isArray(values)) {
        return values.filter(value => typeof value === 'string' && value);
    }
    if (typeof values === 'string' && values) {
        return [values];
    }
    return [];
}

function normalizeLabelId(label) {
    if (!label || typeof label !== 'object') {
        return null;
    }
    return label.label_id || label.id || label.labelId || null;
}

function normalizeLabelName(label) {
    if (!label || typeof label !== 'object') {
        return null;
    }
    return label.name || label.label || label.title || null;
}

function buildEntityLabelMapping(entityRegistry, labelRegistry) {
    const labelNameById = {};
    const labels = Array.isArray(labelRegistry) ? labelRegistry : [];
    const entities = Array.isArray(entityRegistry) ? entityRegistry : [];

    labels.forEach(label => {
        const id = normalizeLabelId(label);
        const name = normalizeLabelName(label);
        if (id && name) {
            labelNameById[id] = name;
        }
    });

    const mapping = {};
    entities.forEach(entity => {
        if (!entity || typeof entity.entity_id !== 'string') {
            return;
        }

        const labelIds = getStringArray(entity.label_ids || entity.labels || entity.labels_ids);
        const normalizedLabels = [];
        labelIds.forEach(labelId => {
            normalizedLabels.push(labelId);
            if (labelNameById[labelId]) {
                normalizedLabels.push(labelNameById[labelId]);
            }
        });
        mapping[entity.entity_id] = [...new Set(normalizedLabels)];
    });

    entityLabelsById = mapping;
}

function updateEntityLabelMapping(callback) {
    if (!shouldFetchLabelRegistryData()) {
        entityLabelsById = {};
        callback && callback();
        return;
    }

    hass.getEntityRegistry((entityErr, entityRegistry) => {
        if (entityErr) {
            adapter.log.warn(`Cannot read Home Assistant entity registry for label filtering: ${entityErr}`);
            entityLabelsById = {};
            callback && callback();
            return;
        }

        hass.getLabelRegistry((labelErr, labelRegistry) => {
            if (labelErr) {
                adapter.log.warn(`Cannot read Home Assistant label registry for label filtering: ${labelErr}`);
            }

            buildEntityLabelMapping(entityRegistry, labelRegistry);
            callback && callback();
        });
    });
}

function syncObjects(objects, cb) {
    if (!objects || !objects.length) {
        return cb();
    }
    const obj = objects.shift();
    hassObjects[obj._id] = obj;

    adapter.getForeignObject(obj._id, (err, oldObj) => {

        err && adapter.log.error(err);

        if (!oldObj) {
            adapter.log.debug(`Create "${obj._id}": ${JSON.stringify(obj.common)}`);
            hassObjects[obj._id] = obj;
            adapter.setForeignObject(obj._id, obj, err => {
                err && adapter.log.error(err);
                setImmediate(syncObjects, objects, cb);
            });
        } else {
            hassObjects[obj._id] = oldObj;
            if (JSON.stringify(obj.native) !== JSON.stringify(oldObj.native)) {
                oldObj.native = obj.native;

                adapter.log.debug(`Update "${obj._id}": ${JSON.stringify(obj.common)}`);
                adapter.setForeignObject(obj._id, oldObj, err => {
                    err => adapter.log.error(err);
                    setImmediate(syncObjects, objects, cb);
                });
            } else {
                setImmediate(syncObjects, objects, cb);
            }
        }
    });
}

function deleteObjectsById(ids, recursive, cb) {
    if (!ids || !ids.length) {
        return cb();
    }

    const id = ids.shift();
    const options = recursive ? {recursive: true} : undefined;

    adapter.delForeignObject(id, options, err => {
        if (err) {
            adapter.log.error(`Cannot delete object "${id}": ${err}`);
        } else {
            adapter.log.debug(`Deleted obsolete object "${id}"`);
            Object.keys(hassObjects).forEach(objId => {
                if (objId === id || objId.startsWith(`${id}.`)) {
                    delete hassObjects[objId];
                }
            });
        }
        setImmediate(deleteObjectsById, ids, recursive, cb);
    });
}

function deleteObsoleteObjects(keepObjectIds, cb) {
    adapter.getForeignObjects(`${adapter.namespace}.entities.*`, (err, objects) => {
        if (err) {
            adapter.log.error(err);
            return cb();
        }

        objects = objects || {};
        const obsoleteChannelIds = [];
        const obsoleteObjectIds = [];

        Object.keys(objects).forEach(id => {
            if (keepObjectIds.has(id)) {
                return;
            }

            if (objects[id] && (objects[id].type === 'channel' || objects[id].type === 'folder')) {
                obsoleteChannelIds.push(id);
            } else {
                obsoleteObjectIds.push(id);
            }
        });

        if (!obsoleteChannelIds.length && !obsoleteObjectIds.length) {
            return cb();
        }

        const obsoleteChannelPrefixes = obsoleteChannelIds.map(id => `${id}.`);
        const singleDeleteIds = obsoleteObjectIds.filter(id => !obsoleteChannelPrefixes.some(prefix => id.startsWith(prefix)));

        deleteObjectsById(singleDeleteIds, false, () =>
            deleteObjectsById(obsoleteChannelIds, true, cb));
    });
}

function cleanupEmptyEntityContainers(cb) {
    const rootEntitiesId = `${adapter.namespace}.entities`;

    function runPass(pass) {
        adapter.getForeignObjects(`${adapter.namespace}.entities.*`, (err, objects) => {
            if (err) {
                adapter.log.error(err);
                return cb();
            }

            objects = objects || {};
            const allIds = Object.keys(objects);

            const containersToDelete = allIds
                .filter(id => objects[id] && objects[id].type !== 'state' && id !== rootEntitiesId)
                .filter(id => !allIds.some(otherId => otherId.startsWith(`${id}.`)));

            if (!containersToDelete.length) {
                return cb();
            }

            deleteObjectsById(containersToDelete, false, () => {
                if (pass >= 50) {
                    adapter.log.warn('cleanupEmptyEntityContainers reached max passes');
                    return cb();
                }
                setImmediate(runPass, pass + 1);
            });
        });
    }

    runPass(1);
}

function getAllEntitiesJson(entities) {
    const entityIds = (entities || [])
        .filter(entity => entity && typeof entity.entity_id === 'string')
        .map(entity => entity.entity_id)
        .sort();
    return JSON.stringify(entityIds);
}

function removeAllEntitiesStateIfNeeded(callback) {
    adapter.delObject('host.all_entities', err => {
        if (err && !String(err).includes('not found')) {
            adapter.log.error(`Cannot delete host.all_entities: ${err}`);
        }
        adapter.delObject('host', err2 => {
            if (err2 && !String(err2).includes('not found')) {
                adapter.log.error(`Cannot delete host channel: ${err2}`);
            }
            lastAllEntitiesJson = null;
            callback && callback();
        });
    });
}

function updateAllEntitiesState(entities, callback) {
    if (!adapter.config.exposeAllEntitiesJson) {
        return removeAllEntitiesStateIfNeeded(callback);
    }

    const json = getAllEntitiesJson(entities);
    if (json === lastAllEntitiesJson) {
        callback && callback();
        return;
    }

    adapter.setObjectNotExists('host', {
        type: 'channel',
        common: {name: 'Host'},
        native: {}
    }, err => {
        if (err) {
            adapter.log.error(err);
            callback && callback();
            return;
        }

        adapter.setObjectNotExists('host.all_entities', {
            type: 'state',
            common: {
                name: 'All Home Assistant entities as JSON',
                role: 'json',
                type: 'string',
                read: true,
                write: false
            },
            native: {}
        }, err2 => {
            if (err2) {
                adapter.log.error(err2);
                callback && callback();
                return;
            }

            adapter.setState('host.all_entities', json, true);
            lastAllEntitiesJson = json;
            callback && callback();
        });
    });
}

function syncRoom(room, members, cb) {
    adapter.getForeignObject(`enum.rooms.${room}`, (err, obj) => {
        if (!obj) {
            obj = {
                _id: `enum.rooms.${room}`,
                type: 'enum',
                common: {
                    name: room,
                    members: members
                },
                native: {}
            };
            adapter.log.debug(`Update "${obj._id}"`);
            adapter.setForeignObject(obj._id, obj, err => {
                err && adapter.log.error(err);
                cb();
            });
        } else {
            obj.common = obj.common || {};
            obj.common.members = obj.common.members || [];
            let changed = false;
            for (let m = 0; m < members.length; m++) {
                if (obj.common.members.indexOf(members[m]) === -1) {
                    changed = true;
                    obj.common.members.push(members[m]);
                }
            }
            if (changed) {
                adapter.log.debug(`Update "${obj._id}"`);
                adapter.setForeignObject(obj._id, obj, err => {
                    err && adapter.log.error(err);
                    cb();
                });
            } else {
                cb();
            }
        }
    });
}

const knownAttributes = {
    azimuth:   {write: false, read: true, unit: '°'},
    elevation: {write: false, read: true, unit: '°'}
};


const ERRORS = {
    1: 'ERR_CANNOT_CONNECT',
    2: 'ERR_INVALID_AUTH',
    3: 'ERR_CONNECTION_LOST'
};
const mapTypes = {
    'string': 'string',
    'number': 'number',
    'object': 'mixed',
    'boolean': 'boolean'
};
const skipServices = [
    'persistent_notification'
];

function parseStates(entities, services, callback) {
    entities = (entities || []).filter(entity => entity && typeof entity.entity_id === 'string' && isEntityAllowed(entity.entity_id));
    allowedEntityIds = new Set(entities.map(entity => entity.entity_id));
    services = services || {};

    const objs   = [];
    const states = [];
    let obj;
    let channel;
    for (let e = 0; e < entities.length; e++) {
        const entity = entities[e];
        if (!entity) continue;

        const name = entity.name || (entity.attributes && entity.attributes.friendly_name ? entity.attributes.friendly_name : entity.entity_id);
        const desc = entity.attributes && entity.attributes.attribution   ? entity.attributes.attribution   : undefined;

        channel = {
            _id: `${adapter.namespace}.entities.${entity.entity_id}`,
            common: {
                name: name
            },
            type: 'channel',
            native: {
                object_id: entity.object_id,
                entity_id: entity.entity_id
            }
        };
        if (desc) channel.common.desc = desc;
        objs.push(channel);

        const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
        const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;

        if (entity.state !== undefined) {
            obj = {
                _id: `${adapter.namespace}.entities.${entity.entity_id}.state`,
                type: 'state',
                common: {
                    name: `${name} STATE`,
                    type: typeof entity.state,
                    read: true,
                    write: false
                },
                native: {
                    object_id:  entity.object_id,
                    domain:     entity.domain,
                    entity_id:  entity.entity_id
                }
            };
            if (entity.attributes && entity.attributes.unit_of_measurement) {
                obj.common.unit = entity.attributes.unit_of_measurement;
            }
            adapter.log.debug(`Found Entity state ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`)
            objs.push(obj);

            let val = entity.state;
            if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                val = JSON.stringify(val);
            }

            states.push({id: obj._id, lc, ts, val, ack: true})
        }

        if (entity.attributes) {
            for (const attr in entity.attributes) {
                if (entity.attributes.hasOwnProperty(attr)) {
                    if (attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon') {
                        continue;
                    }

                    let common;
                    if (knownAttributes[attr]) {
                        common = Object.assign({}, knownAttributes[attr]);
                    } else {
                        common = {};
                    }

                    const attrId = attr.replace(adapter.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                    obj = {
                        _id: `${adapter.namespace}.entities.${entity.entity_id}.${attrId}`,
                        type: 'state',
                        common: common,
                        native: {
                            object_id:  entity.object_id,
                            domain:     entity.domain,
                            entity_id:  entity.entity_id,
                            attr:       attr
                        }
                    };
                    if (!common.name) {
                        common.name = `${name} ${attr.replace(/_/g, ' ')}`;
                    }
                    if (common.read === undefined) {
                        common.read = true;
                    }
                    if (common.write === undefined) {
                        common.write = false;
                    }
                    if (common.type === undefined) {
                        common.type = mapTypes[typeof entity.attributes[attr]];
                    }

                    adapter.log.debug(`Found Entity attribute ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`)

                    objs.push(obj);

                    let val = entity.attributes[attr];
                    if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                        val = JSON.stringify(val);
                    }

                    states.push({id: obj._id, lc, ts, val, ack: true});
                }
            }
        }

        const serviceType = entity.entity_id.split('.')[0];

        if (services[serviceType] && !skipServices.includes(serviceType)) {
            const service = services[serviceType];
            for (const s in service) {
                if (service.hasOwnProperty(s)) {
                    obj = {
                        _id: `${adapter.namespace}.entities.${entity.entity_id}.${s}`,
                        type: 'state',
                        common: {
                            desc: service[s].description,
                            read: false,
                            write: true,
                            type: 'mixed'
                        },
                        native: {
                            object_id:  entity.object_id,
                            domain:     entity.domain,
                            fields:     service[s].fields,
                            entity_id:  entity.entity_id,
                            attr:       s,
                            type:       serviceType
                        }
                    };

                    adapter.log.debug(`Found Entity service ${obj._id}: ${JSON.stringify(obj.common)} / ${JSON.stringify(obj.native)}`)

                    objs.push(obj);
                }
            }
        }
    }

    const keepObjectIds = new Set(objs.map(obj => obj._id));

    syncObjects(objs, () =>
        syncStates(states, () =>
            deleteObsoleteObjects(keepObjectIds, () =>
                cleanupEmptyEntityContainers(callback))));
}

function main() {
    adapter.config.host = adapter.config.host || '127.0.0.1';
    adapter.config.port = parseInt(adapter.config.port, 10) || 8123;
    adapter.config.whitelist = adapter.config.whitelist || '';
    adapter.config.blacklist = adapter.config.blacklist || '';
    adapter.config.labelWhitelist = adapter.config.labelWhitelist || '';
    adapter.config.labelBlacklist = adapter.config.labelBlacklist || '';
    adapter.config.exposeAllEntitiesJson = !!adapter.config.exposeAllEntitiesJson;

    updateEntityFilters();

    adapter.setState('info.connection', false, true);

    hass = new HASS(adapter.config, adapter.log);

    hass.on('error', err =>
        adapter.log.error(err));

    hass.on('state_changed', entity => {
        adapter.log.debug(`HASS-Message: State Changed: ${JSON.stringify(entity)}`);
        if (!entity || typeof entity.entity_id !== 'string') {
            return;
        }
        if (!allowedEntityIds.has(entity.entity_id)) {
            return;
        }

        const id = `entities.${entity.entity_id}.`;
        const lc = entity.last_changed ? new Date(entity.last_changed).getTime() : undefined;
        const ts = entity.last_updated ? new Date(entity.last_updated).getTime() : undefined;
        if (entity.state !== undefined) {
            if (hassObjects[`${adapter.namespace}.${id}state`]) {
                adapter.setState(`${id}state`, {val: entity.state, ack: true, lc: lc, ts: ts});
            } else {
                adapter.log.info(`State changed for unknown object ${`${id}state`}. Please restart the adapter to resync the objects.`);
            }
        }
        if (entity.attributes) {
            for (const attr in entity.attributes) {
                if (!entity.attributes.hasOwnProperty(attr) || attr === 'friendly_name' || attr === 'unit_of_measurement' || attr === 'icon'|| !attr.length) {
                    continue;
                }
                let val = entity.attributes[attr];
                if ((typeof val === 'object' && val !== null) || Array.isArray(val)) {
                    val = JSON.stringify(val);
                }
                const attrId = attr.replace(adapter.FORBIDDEN_CHARS, '_').replace(/\.+$/, '_');
                if (hassObjects[`${adapter.namespace}.${id}state`]) {
                    adapter.setState(id + attrId, {val, ack: true, lc, ts});
                } else {
                    adapter.log.info(`State changed for unknown object ${id + attrId}. Please restart the adapter to resync the objects.`);
                }
            }
        }
    });

    hass.on('connected', () => {
        if (!connected) {
            adapter.log.debug('Connected');
            connected = true;
            adapter.setState('info.connection', true, true);
            hass.getConfig((err, config) => {
                if (err) {
                    adapter.log.error(`Cannot read config: ${err}`);
                    return;
                }
                //adapter.log.debug(JSON.stringify(config));
                delayTimeout = setTimeout(() => {
                    delayTimeout = null;
                    !stopped && hass.getStates((err, states) => {
                        if (stopped) {
                            return;
                        }
                        if (err) {
                            return adapter.log.error(`Cannot read states: ${err}`);
                        }
                        updateAllEntitiesState(states);
                        //adapter.log.debug(JSON.stringify(states));
                        delayTimeout = setTimeout(() => {
                            delayTimeout = null;
                            !stopped && updateEntityLabelMapping(() => {
                                if (stopped) {
                                    return;
                                }
                                hass.getServices((err, services) => {
                                    if (stopped) {
                                        return;
                                    }
                                    if (err) {
                                        adapter.log.error(`Cannot read states: ${err}`);
                                    } else {
                                        //adapter.log.debug(JSON.stringify(services));
                                        parseStates(states, services, () => {
                                            adapter.log.debug('Initial parsing of states done, subscribe to ioBroker states');
                                            adapter.subscribeStates('*');
                                        });
                                    }
                                });
                            })}, 100);
                    })}, 100);
            });
        }
    });

    hass.on('disconnected', () => {
        if (connected) {
            adapter.log.debug('Disconnected');
            connected = false;
            adapter.setState('info.connection', false, true);
        }
    });

    hass.connect();
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
