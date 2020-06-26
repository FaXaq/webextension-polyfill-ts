import { SchemaVisitorFactory } from "../helpers/visitor";
import { SchemaEntry, SchemaProperty, SchemaBaseProperty, SchemaFunctionProperty } from "../helpers/types";
import { modifyMap, modifyArray, toUpperCamelCase } from "../helpers/utils";
import { ErrorMessage } from "../helpers/assert";

// There are a lot of inline types in the schemas (for example a function parameter)
// This fix extracts these inline types into namespace.types and insertes a $ref instead.

function convertToRef(prop: SchemaProperty, id: string, entry: SchemaEntry): SchemaProperty {
    const newProp: SchemaProperty = { $ref: id, type: "ref" };
    if (prop.name) newProp.name = prop.name;
    if (prop.description) newProp.description = prop.description;
    if (!entry.types) entry.types = [];
    if (prop.optional) newProp.optional = prop.optional;
    delete prop.name;
    prop.id = id;
    entry.types.push(prop);

    return newProp;
}

function combineNamePrefix(namePrefix: string, suffix?: string) {
    if (suffix) return namePrefix + toUpperCamelCase(suffix);
    return namePrefix;
}

function convertToRefIfObject(
    prop: SchemaProperty,
    propName: string,
    namePrefix: string | undefined,
    entry: SchemaEntry
) {
    if (
        prop.type === "object" &&
        prop.additionalProperties &&
        prop.additionalProperties !== true &&
        prop.additionalProperties.$ref &&
        !prop.properties
    ) {
        //special case for a map type.. not extracted, will be handled in getType
    } else if (prop.type === "object" && !prop.isInstanceOf && !prop.patternProperties) {
        if (!namePrefix) throw ErrorMessage.MISSING_NAME;
        const name = combineNamePrefix(namePrefix, propName);
        const id = toUpperCamelCase(name) + "Type";
        const newRef = convertToRef(prop, id, entry);
        // extractParameterObjectFromProperty(params[i], name, entry, false);
        return newRef;
    } else if (prop.type === "string" && prop.enum) {
        if (!namePrefix) throw ErrorMessage.MISSING_NAME;
        const name = combineNamePrefix(namePrefix, propName);
        const id = toUpperCamelCase(name) + "Enum";
        return convertToRef(prop, id, entry);
    } else if (prop.type === "choices" && prop.choices) {
        if (prop.choices.length === 1)
            prop.choices[0] = convertToRefIfObject(prop.choices[0], propName, namePrefix, entry);
        else {
            modifyArray(prop.choices, (choice, i) => {
                return convertToRefIfObject(choice, propName + "C" + (i + 1), namePrefix, entry);
            });
        }
    } else if (prop.type === "array" && prop.items && (prop.items.type !== "object" || !prop.items.isInstanceOf)) {
        prop.items = convertToRefIfObject(prop.items, propName + "Item", namePrefix, entry);
    } else if (prop.type === "function") {
        modifyArray(prop.parameters, (param, i) => {
            if (!param.name) throw ErrorMessage.MISSING_NAME;
            return convertToRefIfObject(param, propName + toUpperCamelCase(param.name), namePrefix, entry);
        });
    }
    return prop;
}

function extractParameterObjectFunction(func: SchemaFunctionProperty, entry: SchemaEntry) {
    modifyArray(func.parameters, (param) => {
        if (!param.name) throw ErrorMessage.MISSING_NAME;
        return convertToRefIfObject(param, param.name, func.name, entry);
    });
    if (func.returns) func.returns = convertToRefIfObject(func.returns, "return", func.name, entry);
}

function extractParameterObjectType<T extends SchemaBaseProperty>(
    prop: SchemaProperty,
    namePrefix: string,
    isRoot: boolean,
    entry: SchemaEntry
): T {
    if (prop.type === "object") {
        if (
            prop.additionalProperties &&
            prop.additionalProperties !== true &&
            prop.additionalProperties.type === "object" &&
            !prop.additionalProperties.$ref
        ) {
            extractParameterObjectType(prop.additionalProperties, namePrefix, true, entry);
        }
        modifyMap(prop.properties, (prop, key) =>
            extractParameterObjectType(prop, combineNamePrefix(namePrefix, key), false, entry)
        );
        modifyMap(prop.patternProperties, (prop, key) =>
            extractParameterObjectType(prop, namePrefix + "Pattern", false, entry)
        );
        modifyArray(prop.events, (evt) =>
            extractParameterObjectType(evt, combineNamePrefix(namePrefix, evt.name), false, entry)
        );
        modifyArray(prop.functions, (func) =>
            extractParameterObjectType(func, combineNamePrefix(namePrefix, func.name), false, entry)
        );

        if (!isRoot && !prop.isInstanceOf) {
            if (
                (!prop.properties || Object.keys(prop.properties).length === 0) &&
                prop.additionalProperties &&
                prop.additionalProperties !== true &&
                prop.additionalProperties.type === "array" &&
                prop.additionalProperties.items &&
                prop.additionalProperties.items.type
            ) {
                //special case for a map type.. not extracted, will be handled in getType
            } else if (prop.patternProperties) {
                //special case for a map type.. not extracted, will be handled in getType
            } else {
                if (!namePrefix) throw ErrorMessage.MISSING_NAME;
                const id = namePrefix + "Type";
                prop = convertToRef(prop, id, entry);
            }
        }
    } else if (prop.type === "string" && prop.enum) {
        if (!isRoot) {
            const ref = convertToRefIfObject(prop, "", namePrefix, entry);
            //@ts-ignore
            return ref;
        }
    } else if (prop.type === "array" && prop.items) {
        prop.items = convertToRefIfObject(prop.items, "item", namePrefix, entry);
    } else if (prop.type === "choices" && prop.choices) {
        if (prop.choices.length === 1)
            prop.choices[0] = extractParameterObjectType(prop.choices[0], namePrefix, false, entry);
        else
            modifyArray(prop.choices, (choice, i) =>
                extractParameterObjectType(choice, namePrefix + "C" + (i + 1), false, entry)
            );
    } else if (prop.type === "function") {
        modifyArray(prop.parameters, (param, i) =>
            extractParameterObjectType(param, combineNamePrefix(namePrefix, param.name), false, entry)
        );
        modifyArray(prop.extraParameters, (param, i) =>
            extractParameterObjectType(param, combineNamePrefix(namePrefix, param.name), false, entry)
        );
        if (prop.returns)
            prop.returns = extractParameterObjectType<SchemaProperty>(prop.returns, "Return", false, entry);
    }
    // @ts-ignore
    return prop;
}

function visitor(entry: SchemaEntry) {
    entry.functions?.forEach((func) => extractParameterObjectFunction(func, entry));
    entry.events?.forEach((evt) => extractParameterObjectFunction(evt, entry));
    modifyMap(entry.properties, (prop, key) => {
        if (prop.$ref && prop.hasOwnProperty("properties")) {
            const id = combineNamePrefix(toUpperCamelCase(key), prop.$ref);
            const newProp = {
                type: "object",
                additionalProperties: { $ref: prop.$ref },
                properties: (prop as any).properties,
            };
            //@ts-ignore
            return convertToRef(newProp, id, entry);
        } else {
            return convertToRefIfObject(prop, key, "Property", entry);
        }
    });

    entry.types?.forEach((type) => {
        if (!type.id) throw new Error("Gotta have a prefix, dude!");
        extractParameterObjectType(type, toUpperCamelCase(type.id), true, entry);
    });
    return entry;
}

export const extractInlineContent: SchemaVisitorFactory = () => {
    return {
        name: "extracting inline content",
        visitors: {
            Namespace: visitor,
        },
    };
};
