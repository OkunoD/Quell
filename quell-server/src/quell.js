const redis = require('redis');
const { parse } = require('graphql/language/parser');
const { visit, BREAK } = require('graphql/language/visitor');
const { graphql } = require('graphql');

const parseAST = require('./helpers/parseAST');
const normalizeForCache = require('./helpers/normalizeForCache');
// const buildFromCache = require('./helpers/buildFromCache');
const createQueryObj = require('./helpers/createQueryObj');
const createQueryStr = require('./helpers/createQueryStr');
const joinResponses = require('./helpers/joinResponses');

class QuellCache {
  constructor(schema, redisPort, cacheExpiration = 1000) {
    this.schema = schema;
    this.queryMap = this.getQueryMap(schema);
    this.mutationMap = this.getMutationMap(schema);
    this.fieldsMap = this.getFieldsMap(schema);
    this.idMap = this.getIdMap();
    this.redisPort = redisPort;
    this.cacheExpiration = cacheExpiration;
    this.redisCache = redis.createClient(redisPort);
    this.query = this.query.bind(this);
    this.clearCache = this.clearCache.bind(this);
    this.buildFromCache = this.buildFromCache.bind(this);
    this.generateCacheID = this.generateCacheID.bind(this);
  }

  /**
   * The class's controller method. It:
   *    - reads the query string from the request object,
   *    - tries to construct a response from cache,
   *    - reformulates a query for any data not in cache,
   *    - passes the reformulated query to the graphql library to resolve,
   *    - joins the cached and uncached responses,
   *    - decomposes and caches the joined query, and
   *    - attaches the joined response to the response object before passing control to the next middleware.
   *  @param {Object} req - Express request object, including request body with GraphQL query string
   *  @param {Object} res - Express response object, will carry query response to next middleware
   *  @param {Function} next - Express next middleware function, invoked when QuellCache completes its work
   */
  async query(req, res, next) {
    console.log('reached the server');
    // handle request without query
    if (!req.body.query) {
      return next('Error: no GraphQL query found on request body');
    }
    // retrieve GraphQL query string from request object;
    const queryString = req.body.query;

    // create abstract syntax tree with graphql-js parser
    const AST = parse(queryString);

    // create response prototype, referenses for arguments and operation type
    const { prototype, operationType } = parseAST(AST);

    // not a deep protype copy
    // TO-DO: why do we need a deep copy
    // const protoDeepCopy = { ...prototype };

    // pass-through for queries and operations that QuellCache cannot handle
    if (operationType === 'unQuellable') {
      graphql(this.schema, queryString)
        .then((queryResult) => {
          res.locals.queryResponse = queryResult;
          next();
        })
        .catch((error) => {
          return next('graphql library error: ', error);
        });

      /*
       * we can have two types of operation to take care of
       * MUTATION OR QUERY
       */
      // if MUTATION
    } else if (operationType === 'mutation') {
      // get redis key if possible and potential combined value for future update
      let { redisKey, isExist, redisValue } = await this.createRedisKey(
        this.mutationMap,
        prototype
      );

      graphql(this.schema, queryString)
        .then((mutationResult) => {
          // if redis needs to be updated, write to cache and send result back, we don't need to wait untill writeToCache is finished
          if (isExist) {
            this.writeToCache(redisKey, redisValue);
          }
          res.locals.queryResponse = mutationResult;
          next();
        })
        .catch((error) => {
          return next('graphql library error: ', error);
        });
    } else {
      // if QUERY

      // build response from cache
      // countries -> [country--1, country--2]
      // TO-DO: test that buildFromCache w/o queryMap doesn't produce changes
      // update buildFromCache to update with redis info
      const prototypeKeys = Object.keys(prototype);
      const cacheResponse = await buildFromCache(prototype, prototypeKeys);
      // const responseFromCache = await buildFromCache(
      //   prototype,
      //   this.queryMap,
      // );

      // query for additional information, if necessary
      let mergedResponse, databaseResponse;

      // create query object to check if we have to get something from database
      const queryObject = createQueryObj(prototype);

      // if cached response is incomplete, reformulate query, handoff query, join responses, and cache joined responses
      if (Object.keys(queryObject).length > 0) {
        // create new query sting
        const newQueryString = createQueryStr(queryObject);

        graphql(this.schema, newQueryString)
          .then(async (queryResponse) => {
            databaseResponse = queryResponse.data;

            // join uncached and cached responses, prototype is used as a "template" for final mergedResponse
            mergedResponse = joinResponses(
              cacheResponse,
              databaseResponse,
              prototype
            );

            // TO-DO: update this.cache to use prototype instead of protoArgs
            normalizeForCache(mergedResponse.data, map, prototype, fieldsMap);

            const successfullyCached = await this.cache(
              mergedResponse,
              prototype
            );
            // TO-DO: what to do if not successfully cached?
            // we want to still send response to the client
            // do we care that cache calls are asynchronous, is it worth pausing the client response?


            res.locals.queryResponse = { data: mergedResponse };
            return next();
          })
          .catch((error) => {
            return next('graphql library error: ', error);
          });
      } else {
        // if nothing left to query, response from cache is full response
        res.locals.queryResponse = { data: cacheResponse };
        return next();
      }
    }
  }

  // TO-DO: update mutations
  /**
   * createRedisKey creates key based on field name and argument id and returns string or null if key creation is not possible
   * @param {Object} mutationMap -
   * @param {Object} proto -
   * @param {Object} protoArgs -
   * returns redisKey if possible, e.g. 'Book-1' or 'Book-2', where 'Book' is name from mutationMap and '1' is id from protoArgs
   * and isExist if we have this key in redis
   *
   */
  async createRedisKey(mutationMap, proto) {
    let isExist = false;
    let redisKey;
    let redisValue = null;
    for (const mutationName in proto) {
      // proto.__args
      // mutation { country { id: 123, name: 'asdlkfasldkfa' } }
      const mutationArgs = protoArgs[mutationName];
      redisKey = mutationMap[mutationName];
      for (const key in mutationArgs) {
        let identifier = null;
        if (key === 'id' || key === '_id') {
          identifier = mutationArgs[key];
          redisKey = mutationMap[mutationName] + '-' + identifier;
          isExist = await this.checkFromRedis(redisKey);
          if (isExist) {
            redisValue = await this.getFromRedis(redisKey);
            redisValue = JSON.parse(redisValue);
            // combine redis value and protoArgs
            let argumentsValue;
            for (let mutationName in protoArgs) {
              // change later, now we assume that we have only one mutation
              argumentsValue = protoArgs[mutationName];
            }
            redisValue = this.updateObject(redisValue, argumentsValue);
          }
        }
      }
    }
    return { redisKey, isExist, redisValue };
  }

  /**
   * updateObject updates existing fields in primary object taking incoming value from incoming object, returns new value
   * @param {Object} objectPrimary - object
   * @param {Object} objectIncoming - object
   */
  updateObject(objectPrimary, objectIncoming) {
    const value = {};

    for (const prop in objectPrimary) {
      if (objectIncoming.hasOwnProperty(prop)) {
        if (
          Object.prototype.toString.call(objectPrimary[prop]) ===
          '[object Object]'
        ) {
          // if the property is a nested object
          value[prop] = merge(objectPrimary[prop], objectIncomin[prop]);
        } else {
          value[prop] = objectIncoming[prop] || objectPrimary[prop];
        }
      } else {
        value[prop] = objectPrimary[prop];
      }
    }
    return value;
  }

  /**
   * mergeObjects recursively combines objects together, next object overwrites previous
   * Used to rebuild response from cache and database
   * Uses a prototype to govern the order of fields
   * @param {Array} - rest parameters for all objects passed to function
   * @param {proto} - protoObject
   */
  mergeObjects(proto, ...objects) {
    const isObject = (obj) =>
      Object.prototype.toString.call(obj) === '[object Object]';

    const protoDeepCopy = { ...proto }; // create function to deep copy

    // return func that loop through arguments with reduce
    return objects.reduce((prev, obj) => {
      Object.keys(prev).forEach((key) => {
        const prevVal = prev[key];
        const objVal = obj[key];

        if (Array.isArray(objVal)) {
          const prevArray = Array.isArray(prevVal) ? prevVal : [];
          prev[key] = this.mergeArrays(proto[key], prevArray, objVal);
        } else if (isObject(objVal)) {
          const prevObject = isObject(prevVal) ? prevVal : {};
          prev[key] = this.mergeObjects(proto[key], prevObject, objVal);
        } else {
          prev[key] = objVal || prev[key];
        }
      });
      return prev;
    }, protoDeepCopy);
  }

  /**
   * mergeArrays combines arrays together, next array overwrites previous
   * Used as helper function for mergeObject to handle arrays
   * @param {Array} arrays - rest parameters for all arrays passed to function
   * @param {proto} - protoObject, needed only to pass it to mergeObjects
   */
  mergeArrays(proto, ...arrays) {
    const isObject = (obj) =>
      Object.prototype.toString.call(obj) === '[object Object]';

    return arrays.reduce((prev, arr) => {
      arr.forEach((el, index) => {
        const prevVal = prev[index];
        const arrVal = arr[index];

        if (isObject(prevVal) && isObject(arrVal)) {
          prev[index] = this.mergeObjects(proto, prevVal, arrVal);
        } else {
          prev[index] = arrVal;
        }
      });
      return prev;
    }, []);
  }

  /**
   * checkFromRedis reads from Redis cache and returns a promise.
   * @param {String} key - the key for Redis lookup
   */
  checkFromRedis(key) {
    return new Promise((resolve, reject) => {
      this.redisCache.exists(key, (error, result) =>
      error ? reject(error) : resolve(result)
      );
    });
  }

  /**
   * getFromRedis reads from Redis cache and returns a promise.
   * @param {String} key - the key for Redis lookup
   */
  getFromRedis(key) {
    return new Promise((resolve, reject) => {
      this.redisCache.get(key, (error, result) =>
        error ? reject(error) : resolve(result)
      );
    });
  }

  /**
   *  getMutationMap generates a map of mutation to GraphQL object types. This mapping is used
   *  to identify references to cached data when mutation occurs.
   */
  getMutationMap(schema) {
    const mutationMap = {};
    // get object containing all root mutations defined in the schema
    const mutationTypeFields = schema._mutationType._fields;
    // if queryTypeFields is a function, invoke it to get object with queries
    const mutationsObj =
      typeof mutationTypeFields === 'function'
        ? mutationTypeFields()
        : mutationTypeFields;
    for (const mutation in mutationsObj) {
      // get name of GraphQL type returned by query
      // if ofType --> this is collection, else not collection
      let returnedType;
      if (mutationsObj[mutation].type.ofType) {
        returnedType = [];
        returnedType.push(mutationsObj[mutation].type.ofType.name);
      }
      if (mutationsObj[mutation].type.name) {
        returnedType = mutationsObj[mutation].type.name;
      }
      mutationMap[mutation] = returnedType;
    }

    return mutationMap;
  }

  /**
   *  getQueryMap generates a map of queries to GraphQL object types. This mapping is used
   *  to identify and create references to cached data.
   */
  getQueryMap(schema) {
    const queryMap = {};
    // get object containing all root queries defined in the schema
    const queryTypeFields = schema._queryType._fields;

    // if queryTypeFields is a function, invoke it to get object with queries
    const queriesObj =
      typeof queryTypeFields === 'function'
        ? queryTypeFields()
        : queryTypeFields;
    for (const query in queriesObj) {
      // get name of GraphQL type returned by query
      // if ofType --> this is collection, else not collection
      let returnedType;
      if (queriesObj[query].type.ofType) {
        returnedType = [];
        returnedType.push(queriesObj[query].type.ofType.name);
      }
      if (queriesObj[query].type.name) {
        returnedType = queriesObj[query].type.name;
      }
      queryMap[query] = returnedType;
    }

    return queryMap;
  }

  /**
   * getFieldsMap generates of map of fields to GraphQL types. This mapping is used to identify
   * and create references to cached data.
   */
  getFieldsMap(schema) {
    const fieldsMap = {};
    const typesList = schema._typeMap;
    const builtInTypes = [
      'String',
      'Int',
      'Float',
      'Boolean',
      'ID',
      'Query',
      '__Type',
      '__Field',
      '__EnumValue',
      '__DirectiveLocation',
      '__Schema',
      '__TypeKind',
      '__InputValue',
      '__Directive',
    ];
    // exclude built-in types
    const customTypes = Object.keys(typesList).filter(
      (type) => !builtInTypes.includes(type) && type !== schema._queryType.name
    );
    // loop through types
    for (const type of customTypes) {
      const fieldsObj = {};
      let fields = typesList[type]._fields;
      if (typeof fields === 'function') fields = fields();
      for (const field in fields) {
        const key = fields[field].name;
        const value = fields[field].type.ofType
          ? fields[field].type.ofType.name
          : fields[field].type.name;
        fieldsObj[key] = value;
      }
      // place assembled types on fieldsMap
      fieldsMap[type] = fieldsObj;
    }
    return fieldsMap;
  }

  getIdMap() {
    const idMap = {};
    for (const type in this.fieldsMap) {
      const userDefinedIds = [];
      const fieldsAtType = this.fieldsMap[type];
      for (const key in fieldsAtType) {
        if (fieldsAtType[key] === 'ID') userDefinedIds.push(key);
      }
      idMap[type] = userDefinedIds;
    }
    return idMap;
  }

  /**
   * Toggles to false all values in a nested field not present in cache so that they will
   * be included in the reformulated query.
   * @param {Object} proto - The prototype or a nested field within the prototype
   */
  toggleProto(proto) {
    for (const key in proto) {
      if (Object.keys(proto[key]).length > 0) this.toggleProto(proto[key]);
      else proto[key] = false;
    }
    return proto;
  }
  // to do: remove deprecated
  // async buildFromCacheDeprecated(proto, map, protoArgs) {
  //   const response = {};

  //   for (const superField in proto) {
  //     let identifierForRedis = superField;

  //     // check if current chunk of data is collection or single item based on what we have in map
  //     const mapValue = map[superField];
  //     const isCollection = Array.isArray(mapValue);

  //     // if we have current chunk as a collection we have to treat it as an array

  //     if (isCollection) {
  //       if (protoArgs != null && protoArgs.hasOwnProperty(superField)) {
  //         for (const key in protoArgs[superField]) {
  //           if (key.includes('id')) {
  //             identifierForRedis =
  //               identifierForRedis + '-' + protoArgs[superField][key];
  //           }
  //         }
  //       }

  //       let collection;
  //       const currentCollection = [];

  //       // try to retrieve array of references from cache
  //       const collectionFromCache = await this.getFromRedis(identifierForRedis);

  //       if (!collectionFromCache) collection = [];
  //       else collection = JSON.parse(collectionFromCache);

  //       if (collection.length === 0) {
  //         const toggledProto = this.toggleProto(proto[superField]); // have to refactor to create deep copy instead of mutation of proto
  //         proto[superField] = { ...toggledProto };
  //       }

  //       for (const item of collection) {
  //         let itemFromCache = await this.getFromRedis(item);
  //         itemFromCache = itemFromCache ? JSON.parse(itemFromCache) : {};
  //         const builtItem = await this.buildItem(
  //           proto[superField],
  //           itemFromCache
  //         );
  //         currentCollection.push(builtItem);
  //       }
  //       response[superField] = currentCollection;
  //     } else {
  //       // we have an object
  //       const idKey =
  //         protoArgs[superField]['id'] || protoArgs[superField]['_id'] || null;
  //       const item = `${map[superField]}-${idKey}`;

  //       let itemFromCache = await this.getFromRedis(item);
  //       itemFromCache = itemFromCache ? JSON.parse(itemFromCache) : {};
  //       const builtItem = await this.buildItem(
  //         proto[superField],
  //         itemFromCache
  //       );

  //       response[superField] = builtItem;

  //       if (Object.keys(builtItem).length === 0) {
  //         const toggledProto = this.toggleProto(proto[superField]); // have to refactor to create deep copy instead of mutation of proto
  //         proto[superField] = { ...toggledProto };
  //       }
  //     }
  //   }

  //   return response;
  // }

  // async buildFromCacheAlsoDeprecated(prototype, prototypeKeys, itemFromCache = {}, firstRun = true) {
  
  //   // update function to include responseFromCache
  //   // const buildProtoFunc = buildPrototypeKeys(prototype);
  //   // const prototypeKeys = buildProtoFunc();
  
  //   for (let typeKey in prototype) {
  //     // check if typeKey is a rootQuery (i.e. if it includes '--') or if its a field nested in a query
  //     // end goal: delete typeKey.includes('--') and check if protoObj.includes(typeKey)
  //     if (prototypeKeys.includes(typeKey)) { //To do - won't always cache, bring map back or persist -- in parsedAST function?
  //       // if typeKey is a rootQuery, then clear the cache and set firstRun to true 
  //       // cached data must persist 
  //       // create a property on itemFromCache and set the value to the fetched response from cache
  //       // pull from redis using get
  //       const cacheResult = this.getFromRedis(typeKey);
  //       itemFromCache[typeKey] = JSON.parse(cacheResult);
  //     }
  //     // if itemFromCache is an array (Array.isArray()) 
  //     if (Array.isArray(itemFromCache[typeKey])) {
  //       // iterate over countries
  //       itemFromCache[typeKey].forEach((currTypeKey, i) => {
  //         const cacheResult = this.getFromRedis(currTypeKey);
  //         const interimCache = JSON.parse(cacheResult);
  //         // console.log('prototype in forEach: ', prototype)
  //         // console.log('prototype[typeKey] in forEach: ', prototype[typeKey])
  //         // console.log('interimCache: ', interimCache);
  
  //         //iterate through iterimCache (for ... in loop)
  //         for (let property in interimCache) {
  //           let tempObj = {};
  //           //if current interimCache property I'm looking for is in prototype
  //           if (prototype[typeKey].hasOwnProperty(property)){
  //             //then create item in itemFromCache from proto at index i
  //             tempObj[property] = interimCache[property]
  //             itemFromCache[typeKey][i] = tempObj;
  //           }
  //         }
  //       })
  //       // reasign itemFromCache[typeKey] to false
  //       // itemFromCache[typeKey] = false;
  //     }
  //       // recurse through buildFromCache using typeKey, prototype
  //     // if itemFromCache is empty, then check the cache for data, else, persist itemFromCache
  //     // if this iteration is a nested query (i.e. if typeKey is a field in the query)
  //     if (firstRun === false) {
  //       // if this field is NOT in the cache, then set this field's value to false
  //       if (
  //         (itemFromCache === null || !itemFromCache.hasOwnProperty(typeKey)) && 
  //         typeof prototype[typeKey] !== 'object') {
  //           prototype[typeKey] = false; 
  //       } 
  //       // if this field is a nested query, then recurse the buildFromCache function and iterate through the nested query
  //       if (
  //         (itemFromCache === null || itemFromCache.hasOwnProperty(typeKey)) && 
  //         !typeKey.includes('__') && // do not iterate through __args or __alias
  //         typeof prototype[typeKey] === 'object') { 
  //           // repeat function inside of the nested query
  //           this.buildFromCache(prototype[typeKey], prototypeKeys, itemFromCache[typeKey], false);
  //       } 
  //     }
  //     // if the current element is not a nested query, then iterate through every field on the typeKey
  //     else {
  //       for (let field in prototype[typeKey]) {
  //         // console.log('field: ', field);
  //         // console.log('itemFromCache[typeKey]: ', itemFromCache[typeKey])
  //         // if itemFromCache[typeKey] === false then break
  //         if (
  //           // if field is not found in cache then toggle to false
  //           !itemFromCache[typeKey].hasOwnProperty(field) && 
  //           !field.includes("__") && // ignore __alias and __args
  //           typeof prototype[typeKey][field] !== 'object') {
  //             prototype[typeKey][field] = false; 
  //         } 
  //         if ( 
  //           // if field contains a nested query, then recurse the function and iterate through the nested query
  //           !field.includes('__') && 
  //           typeof prototype[typeKey][field] === 'object') {
  //             // console.log("PRE-RECURSE prototype[typeKey][field]: ", prototype[typeKey][field]);
  //             // console.log("PRE-RECURSE itemFromCache: ", itemFromCache);
  //             this.buildFromCache(prototype[typeKey][field], prototypeKeys, itemFromCache[typeKey][field], false);
  //           } 
  //       }  
  //     }
  //   }
  //   // assign the value of an object with a key of data and a value of itemFromCache and return
  //   return { data: itemFromCache }
  // }

  async buildFromCache(prototype, prototypeKeys, itemFromCache = {}, firstRun = true) {
  
    // can we build prototypeKeys within the application?
    // const prototypeKeys = Object.keys(prototype)
  
    // update function to include responseFromCache
    // const buildProtoFunc = buildPrototypeKeys(prototype);
    // const prototypeKeys = buildProtoFunc();
  
    // 
    for (let typeKey in prototype) {
      // check if typeKey is a rootQuery (i.e. if it includes '--') or if its a field nested in a query
      // end goal: delete typeKey.includes('--') and check if protoObj.includes(typeKey)
      if (prototypeKeys.includes(typeKey)) {
        const cacheID = this.generateCacheID(prototype[typeKey]);
        //To do - won't always cache, bring map back or persist -- in parsedAST function?
        // if typeKey is a rootQuery, then clear the cache and set firstRun to true 
        // cached data must persist 
        // create a property on itemFromCache and set the value to the fetched response from cache
        const isExist = await this.checkFromRedis(cacheID);
        if (isExist) {
          const cacheResponse = await this.getFromRedis(cacheID);
          // console.log(`cacheResponse is ${cacheResponse}`);
          itemFromCache[typeKey] = JSON.parse(cacheResponse);
          console.log(`itemFromCache[typeKey] is`, itemFromCache[typeKey]);
          console.log(`keys saved to itemFromCache are ${Object.keys(itemFromCache)}`);
          // console.log(`itemFromCache: ${itemFromCache}`);
        }
      }
      // if itemFromCache is an array (Array.isArray()) 
      if (Array.isArray(itemFromCache[typeKey])) {
        // iterate over countries
        itemFromCache[typeKey].forEach(async (currTypeKey, i) => {
          // TO-DO: decide between redisKey vs generateCacheId
          console.log(`currTypeKey is ${currTypeKey} and typeof is ${typeof currTypeKey}`);
          // TO-DO: error handling in the getFromRedis test
          const cacheResponse = await this.getFromRedis(currTypeKey);
          // const isExist = await this.getFromRedis(currTypeKey);
          console.log(`cacheResponse is ${cacheResponse} for ${currTypeKey}`);
          if (cacheResponse) {
            const cacheID = this.generateCacheID(prototype);
            const interimCache = JSON.parse(cacheResponse);
            console.log(`interimCache's keys are ${Object.keys(interimCache)}`);
            console.log(`cacheResponse is ${cacheResponse}`);

          // loop through prototype at typeKey
          for (const property in prototype[typeKey]) {
            let tempObj = {};
            console.log(property, Object.keys(interimCache));
            // if interimCache has the property
            if (interimCache.hasOwnProperty(property) && !property.includes('__')) {
              console.log(`interimCache[property] is ${interimCache[property]} for ${property}`);
              // place on tempObj, set into array
              tempObj[property] = interimCache[property]
              itemFromCache[typeKey][i] = tempObj;
            } else if (!property.includes('__')) {
              // if interimCache does not have property, set to false on prototype so it is fetched
              prototype[typeKey][property] = false;
            } 
            
          }
        }
        // if there is nothign in the cache for this key, then toggle all fields to false
        // TO-DO make sure this works for nested objects
        else {
          for (const property in prototype[typeKey]) {
            // if interimCache has the property
            if (!property.includes('__')) {
              // if interimCache does not have property, set to false on prototype so it is fetched
              prototype[typeKey][property] = false;
            } 
          }
        }

        })
        // reasign itemFromCache[typeKey] to false
        // itemFromCache[typeKey] = false;
      }
        // recurse through buildFromCache using typeKey, prototype
      // if itemFromCache is empty, then check the cache for data, else, persist itemFromCache
      // if this iteration is a nested query (i.e. if typeKey is a field in the query)
      else if (firstRun === false) {
        // console.log('iFC', itemFromCache);
  
        // if this field is NOT in the cache, then set this field's value to false
        if (
          (itemFromCache === null || !itemFromCache.hasOwnProperty(typeKey)) && 
          typeof prototype[typeKey] !== 'object' && !typeKey.includes('__')) {
            prototype[typeKey] = false; 
        } 
        // if this field is a nested query, then recurse the buildFromCache function and iterate through the nested query
        if (
          (itemFromCache === null || itemFromCache.hasOwnProperty(typeKey)) && 
          !typeKey.includes('__') && // do not iterate through __args or __alias
          typeof prototype[typeKey] === 'object') {
            const cacheID = this.generateCacheID(prototype);
            // console.log('cacheID not first Run', cacheID, 'typeKey', typeKey);
            const cacheResponse = this.getFromRedis(currTypeKey);
            itemFromCache[typeKey] = JSON.parse(cacheResponse);
            // repeat function inside of the nested query
          this.buildFromCache(prototype[typeKey], prototypeKeys, itemFromCache[typeKey], false);
        } 
      }
      // if the current element is not a nested query, then iterate through every field on the typeKey
      else {
        for (let field in prototype[typeKey]) {
          // console.log('typeKey', typeKey, 'field: ', field);
          // console.log('itemFromCache: ', itemFromCache)
          // if itemFromCache[typeKey] === false then break
  
          if (
            // if field is not found in cache then toggle to false
            itemFromCache[typeKey] &&
            !itemFromCache[typeKey].hasOwnProperty(field) && 
            !field.includes("__") && // ignore __alias and __args
            typeof prototype[typeKey][field] !== 'object') {
              // console.log(`itemFromCache[typeKey] is ${itemFromCache[typeKey]}`);
              console.log(`field is ${field} and typeof itemFromCache[typeKey] is ${typeof itemFromCache[typeKey]}`);
              prototype[typeKey][field] = false; 
          }
          
          if ( 
            // if field contains a nested query, then recurse the function and iterate through the nested query
            !field.includes('__') && 
            typeof prototype[typeKey][field] === 'object') {
              // console.log("PRE-RECURSE prototype[typeKey][field]: ", prototype[typeKey][field]);
              // console.log("PRE-RECURSE itemFromCache: ", itemFromCache);
            
            this.buildFromCache(prototype[typeKey][field], prototypeKeys, itemFromCache[typeKey][field], false);
            } 
        }  
      }
    }
    // assign the value of an object with a key of data and a value of itemFromCache and return
    return { data: itemFromCache }
  }
  
  // helper function to take in queryProto and generate a cacheID from it
  generateCacheID(queryProto) {
  
    // if ID field exists, set cache ID to 'fieldType--ID', otherwise just use fieldType
    const cacheID = queryProto.__id ? `${queryProto.__type}--${queryProto.__id}` : queryProto.__type;
  
    return cacheID;
  }

  /**
   * buildCollection
   * @param {Object} proto
   * @param {Object} colleciton
   */

  async buildCollection(proto, collection) {
    const response = [];
    for (const superField in proto) {
      if (!collection) {
        collection = [];
      }
      if (collection.length === 0) {
        const toggledProto = this.toggleProto(proto[superField]); // have to refactor to create deep copy instead of mutation of proto
        proto[superField] = { ...toggledProto };
      }
      for (const item of collection) {
        let itemFromCache = await this.getFromRedis(item);
        itemFromCache = itemFromCache ? JSON.parse(itemFromCache) : {};
        const builtItem = await this.buildItem(
          proto[superField],
          itemFromCache
        );
        response.push(builtItem);
      }
    }
    return response;
  }
  

  /**
   * buildItem iterates through keys -- defined on pass-in prototype object, which is always a fragment of the
   * prototype, assigning to nodeObject the data at matching keys in the passed-in item. If a key on the prototype
   * has an object as its value, build array is recursively called.
   * If item does not have a key corresponding to prototype, that field is toggled to false on prototype object. Data
   * for that field will need to be queried.
   * @param {Object} proto
   * @param {Object} fieldsMap
   * @param {Object} item
   */
  async buildItem(proto, item) {
    const nodeObject = {};
    for (const key in proto) {
      if (typeof proto[key] === 'object') {
        // if field is an object, recursively call buildCollection
        const protoAtKey = { [key]: proto[key] };

        nodeObject[key] = await this.buildCollection(protoAtKey, item[key]); // it also can be object, needs to be refactored
      } else if (proto[key]) {
        // if current key has not been toggled to false because it needs to be queried
        if (item[key] !== undefined) nodeObject[key] = item[key];
        else proto[key] = false; // toggle proto key to false if cached item does not contain queried data
      }
    }
    return nodeObject;
  }

  // /**
  //  * createQueryObj traverses the prototype, removing fields that were retrieved from cache. The resulting object
  //  * will be passed to createQueryStr to construct a query requesting only the data not found in cache.
  //  * @param {Object} proto - the prototype with fields that still need to be queried toggled to false
  //  */
  // createQueryObj(proto) {
  //   const queryObj = {};
  //   for (const key in proto) {
  //     const reduced = this.protoReducer(proto[key]);
  //     if (reduced.length > 0) queryObj[key] = reduced;
  //   }
  //   return queryObj;
  // }

  // /**
  //  * protoReducer is a helper function (recusively) called from within createQueryObj, allowing introspection of
  //  * nested prototype fields.
  //  * @param {Object} proto - prototype
  //  */
  // protoReducer(proto) {
  //   const fields = [];
  //   for (const key in proto) {
  //     if (proto[key] === false) fields.push(key);
  //     if (typeof proto[key] === 'object') {
  //       const nestedObj = {};
  //       const reduced = this.protoReducer(proto[key]);
  //       if (reduced.length > 0) {
  //         nestedObj[key] = reduced;
  //         fields.push(nestedObj);
  //       }
  //     }
  //   }
  //   return fields;
  // }

  /**
   * createQueryStr converts the query object constructed in createQueryObj into a properly-formed GraphQL query,
   * requesting just those fields not found in cache.
   * @param {Object} queryObject - object representing queried fields not found in cache
   */
  createQueryStr(queryObject, queryArgsObject) {
    const openCurl = " { ";
    const closedCurl = " } ";
    let queryString = "";
    for (const key in queryObject) {
      if (queryArgsObject && queryArgsObject[key]) {
        let argString = '';

        const openBrackets = ' (';
        const closeBrackets = ' )';
        argString += openBrackets;
        for (const item in queryArgsObject[key]) {
          argString += item + ': ' + queryArgsObject[key][item];
        }
        argString += closeBrackets;
        queryString +=
          key +
          argString +
          openCurl +
          this.queryStringify(queryObject[key]) +
          closedCurl;
      } else {
        queryString +=
          key + openCurl + this.queryStringify(queryObject[key]) + closedCurl;
      }
    }
    return openCurl + queryString + closedCurl;
  }
  /**
   * queryStringify is a helper function called from within createQueryStr. It iterates through an
   * array of field names, concatenating them into a fragment of the query string being constructed
   * in createQueryStr.
   * @param {Array} fieldsArray - array listing fields to be added to GraphQL query
   */
  queryStringify(fieldsArray) {
    const openCurl = ' { ';
    const closedCurl = ' } ';
    let innerStr = '';
    for (let i = 0; i < fieldsArray.length; i += 1) {
      if (typeof fieldsArray[i] === 'string') {
        innerStr += fieldsArray[i] + ' ';
      }
      if (typeof fieldsArray[i] === 'object') {
        for (const key in fieldsArray[i]) {
          innerStr +=
            key +
            openCurl +
            this.queryStringify(fieldsArray[i][key]) +
            closedCurl;
        }
      }
    }
    return innerStr;
  }

  async joinArrays(cachedData, uncachedData) {
    let joinedData;

    // if we have an array run initial logic for array
    if (Array.isArray(uncachedData)) {
      joinedData = [];
      for (let i = 0; i < uncachedData.length; i += 1) {
        const joinedItem = await this.recursiveJoin(
          cachedData[i],
          uncachedData[i]
        );
        joinedData.push(joinedItem);
      }
      // if we have an obj skip array iteration and call recursiveJoin
    } else {
      joinedData = {};
      for (const key in uncachedData) {
        joinedData[key] = {};
        const joinedItem = await this.recursiveJoin(
          cachedData[key],
          uncachedData[key]
        );
        joinedData[key] = { ...joinedItem };
      }
    }
    return joinedData;
  }

  /**
   * recursiveJoin is a helper function called from within joinArrays, allowing nested fields to be merged before
   * returning the fully-merged item to joinResponses to be pushed onto results array. If same keys are present in
   * both cachedItem and uncached Item, uncachedItem -- which is the more up-to-date data -- will overwrite cachedItem.
   * @param {Object} cachedItem - base item
   * @param {Object} uncachedItem - item to be merged into base
   */
  async recursiveJoin(cachedItem, uncachedItem) {
    const joinedObject = cachedItem || {};

    for (const field in uncachedItem) {
      if (Array.isArray(uncachedItem[field])) {
        if (typeof uncachedItem[field][0] === 'string') {
          const temp = [];
          for (let reference of uncachedItem[field]) {
            let itemFromCache = await this.getFromRedis(reference);
            itemFromCache = itemFromCache ? JSON.parse(itemFromCache) : {};
            temp.push(itemFromCache);
          }
          uncachedItem[field] = temp;
        }
        if (cachedItem && cachedItem[field]) {
          joinedObject[field] = await this.joinArrays(
            cachedItem[field],
            uncachedItem[field]
          );
        } else {
          if (uncachedItem[field]) {
            joinedObject[field] = await this.joinArrays(
              [],
              uncachedItem[field]
            );
          } else {
            joinedObject[field] = uncachedItem[field];
          }
        }
      } else {
        joinedObject[field] = uncachedItem[field];
      }
    }
    return joinedObject;
  }
  /**
   * generateId generates a unique ID to refer to an item in cache. Each id concatenates the object type with an
   * id property (user-defined key from this.idMap, item.id or item._id). If no id property is present, the item is declared uncacheable.
   * @param {String} collection - name of schema type, used to identify each cacheable object
   * @param {Object} item - the object, including those keys that might identify it uniquely
   */
  generateId(collection, item) {
    let userDefinedId;
    const idMapAtCollection = this.idMap[collection];
    if (idMapAtCollection.length > 0) {
      for (const identifier of idMapAtCollection) {
        if (!userDefinedId) userDefinedId = item[identifier];
        else userDefinedId += item[identifier];
      }
    }
    const identifier = userDefinedId || item.id || item._id || 'uncacheable';
    return collection + '--' + identifier.toString();
  }

  /**
   * writeToCache writes a value to the cache unless the key indicates that the item is uncacheable. Note: writeToCache will JSON.stringify the input item
   * writeTochache will set expiration time for each item written to cache
   * @param {String} key - unique id under which the cached data will be stored
   * @param {Object} item - item to be cached
   */
  writeToCache(key, item) {
    if (!key.includes('uncacheable')) {
      this.redisCache.set(key, JSON.stringify(item));
      this.redisCache.EXPIRE(key, this.cacheExpiration);
    }
  }

  /**
   * replaceitemsWithReferences takes an array of objects and returns an array of references to those objects.
   * @param {String} queryName - name of the query or object type, to create type-governed references
   * @param {String} field - name of the field, used to find appropriate object type
   * @param {Array} array - array of objects to be converted into references
   */
  replaceItemsWithReferences(queryName, field, array) {
    const arrayOfReferences = [];
    const typeQueried = this.queryMap[queryName];
    const collectionName = this.fieldsMap[typeQueried][field];
    for (const item of array) {
      this.writeToCache(this.generateId(collectionName, item), item);
      arrayOfReferences.push(this.generateId(collectionName, item));
    }
    return arrayOfReferences;
  }

  /**
   * cache iterates through joined responses, writing each item and the array of responses to cache.
   *   - Normalization: items stored elsewhere in cache are replaced with a reference to that item.
   *   - Prevent data loss: Each item of the response is merged with what is in cache to ensure that no data
   *     present in the cache but not requested by the current query is lost.
   * @param {object} responseObject - the response merged from cache and graphql query resolution
   * @param {String} queryName - the name of the query, used for identifying response arrays in cache
   */

  // normalizeForCache Equivalent
  // pull down from cache
  // merge response & cache data
  // send updated data to cache

  // can recurse through responseObject and prototype at same time because same keys
  // currently doesn't recurse through cache, limits to bottom two levels
  // TO-DO replace cache with normalizeForCache and introduce it as a method on this object (so that it can have access to redisCache)
  async cache(responseObject, prototype) {
    const collection = JSON.parse(JSON.stringify(responseObject));

    for (const field in collection) {
      // check if current data chunk is collection
      const currentDataPiece = collection[field];
      let collectionName = this.queryMap[field];
      collectionName = Array.isArray(collectionName)
        ? collectionName[0]
        : collectionName;

      if (Array.isArray(currentDataPiece)) {
        const referencesToCache = [];
        for (const item of currentDataPiece) {
          const cacheId = this.generateId(collectionName, item);
          if (cacheId.includes('uncacheable')) return false;
          let itemFromCache = await this.getFromRedis(cacheId);

          itemFromCache = itemFromCache ? JSON.parse(itemFromCache) : {};
          const joinedWithCache = await this.recursiveJoin(item, itemFromCache);

          const itemKeys = Object.keys(joinedWithCache);
          for (const key of itemKeys) {
            if (Array.isArray(joinedWithCache[key])) {
              joinedWithCache[key] = this.replaceItemsWithReferences(
                field,
                key,
                joinedWithCache[key]
              );
            }
          }

          // Write individual objects to cache (e.g. separate object for each single city)
          this.writeToCache(cacheId, joinedWithCache);
          // Add reference to array if item it refers to is cacheable
          if (!cacheId.includes('uncacheable')) referencesToCache.push(cacheId);
        }

        // Write the non-empty array of references to cache (e.g. 'City': ['City-1', 'City-2', 'City-3'...])
        if (referencesToCache.length > 0) {
          let identifierInRedis = field;
          if (protoArgs != null && protoArgs.hasOwnProperty(field)) {
            for (const key in protoArgs[field]) {
              if (key.includes('id')) {
                identifierInRedis =
                  identifierInRedis + '-' + protoArgs[field][key];
              }
            }
          }
          this.writeToCache(identifierInRedis, referencesToCache);
        }
      } else {
        const cacheId = this.generateId(collectionName, currentDataPiece);
        if (cacheId.includes('uncacheable')) return false;

        let itemFromCache = await this.getFromRedis(cacheId);
        itemFromCache = itemFromCache ? JSON.parse(itemFromCache) : {};
        const joinedWithCache = await this.recursiveJoin(
          currentDataPiece,
          itemFromCache
        );
        const itemKeys = Object.keys(joinedWithCache);
        for (const key of itemKeys) {
          if (Array.isArray(joinedWithCache[key])) {
            joinedWithCache[key] = this.replaceItemsWithReferences(
              field,
              key,
              joinedWithCache[key]
            );
          }
        }
        // Write individual objects to cache (e.g. separate object for each single city)
        this.writeToCache(cacheId, joinedWithCache);
      }
    }
    return true;
  }

  async normalizeForCache(responseData, map, protoField, fieldsMap) {
    // iterate over keys in our response data object 
    for (const resultName in responseData) {
      // currentField we are iterating over
      const currField = responseData[resultName];
      // check if the value stored at that key is array 
      if (Array.isArray(currField)) {
        // RIGHT NOW: countries: [{}, {}]
        // GOAL: countries: ["Country--1", "Country--2"]
  
        // create empty array to store refs
        // ie countries: ["country--1", "country--2"]
        const refList = [];
  
        // iterate over countries array
        currField.forEach(el => {
          // el1 = {id: 1, name: Andorra}, el2 =  {id: 2, name: Bolivia}
          // for each object
          // "resultName" is key on "map" for our Data Type
          const dataType = map[resultName];
  
          // grab ID from object we are iterating over
          let fieldID = dataType;
          for (const key in el) {
            // if key is an ID, append to fieldID for caching
            if (key === 'id' || key === '_id' || key === 'ID' || key === 'Id') {
              fieldID += `--${el[key]}`;
              // push fieldID onto refList
              refList.push(fieldID);
            }
          }
  
          // if object, recurse to add all nested values of el to cache as individual entries
          if (typeof el === 'object') {
            normalizeForCache({ [dataType]: el }, map,  { [dataType]: protoField[resultName][fieldID]});
          }
        })
  
        await this.writeToCache(resultName, JSON.stringify(refList));
      }
      else if (typeof currField === 'object') {
        // temporary store for field properties
        const fieldStore = {};
        
        // if object has id, generate fieldID 
        let fieldID = resultName;
  
        // iterate over keys in object
        // "id, name, cities"
        for (const key in currField) {
          // if ID, create fieldID
          if (key === 'id' || key === '_id' || key === 'ID' || key === 'Id') {
            fieldID += `--${currField[key]}`;
          }
          fieldStore[key] = currField[key];
  
          // if object, recurse normalizeForCache assign in that object
          // must also pass in protoFields object to pair arguments, aliases with response
          if (typeof currField[key] === 'object') {
            normalizeForCache({ [key]: currField[key] }, map, { [key]: protoField[resultName][key]});
          }
        }
        // store "current object" on cache in JSON format
        await this.writeToCache(fieldID, JSON.stringify(fieldStore));
      }
    }
  }
  

  /**
   * clearCache flushes the Redis cache. To clear the cache from the client, establish an endpoint that
   * passes the request and response objects to an instance of QuellCache.clearCache.
   * @param {Object} req
   * @param {Object} res
   * @param {Function} next
   */
  clearCache(req, res, next) {
    this.redisCache.flushall();
    next();
  }
}

module.exports = QuellCache;

// HERE THERE BE DRAGONS ----------------------
  /**
   * parseAST traverses the abstract syntax tree and creates a prototype object
   * representing all the queried fields nested as they are in the query. The
   * prototype object is used as
   *  (1) a model guiding the construction of responses from cache
   *  (2) a record of which fields were not present in cache and therefore need to be queried
   *  (3) a model guiding the construction of a new, partial GraphQL query
   */
  // parseAST(AST) {
  //   // initialize prototype as empty object
  //   const proto = {};
  //   //let isQuellable = true;

  //   let operationType;

  //   // initialiaze arguments as null
  //   let protoArgs = null; //{ country: { id: '2' } }

  //   // initialize stack to keep track of depth first parsing
  //   const stack = [];

  //   /**
  //    * visit is a utility provided in the graphql-JS library. It performs a
  //    * depth-first traversal of the abstract syntax tree, invoking a callback
  //    * when each SelectionSet node is entered. That function builds the prototype.
  //    * Invokes a callback when entering and leaving Field node to keep track of nodes with stack
  //    *
  //    * Find documentation at:
  //    * https://graphql.org/graphql-js/language/#visit
  //    */
  //   visit(AST, {
  //     enter(node) {
  //       if (node.directives) {
  //         if (node.directives.length > 0) {
  //           isQuellable = false;
  //           return BREAK;
  //         }
  //       }
  //     },
  //     OperationDefinition(node) {
  //       operationType = node.operation;
  //       if (node.operation === 'subscription') {
  //         operationType = 'unQuellable';
  //         return BREAK;
  //       }
  //     },
  //     Field: {
  //       enter(node) {
  //         if (node.alias) {
  //           operationType = 'unQuellable';
  //           return BREAK;
  //         }
  //         if (node.arguments && node.arguments.length > 0) {
  //           protoArgs = protoArgs || {};
  //           protoArgs[node.name.value] = {};

  //           // collect arguments if arguments contain id, otherwise make query unquellable
  //           // hint: can check for graphQl type ID instead of string 'id'
  //           for (let i = 0; i < node.arguments.length; i++) {
  //             const key = node.arguments[i].name.value;
  //             const value = node.arguments[i].value.value;

  //             // for queries cache can handle only id as argument
  //             if (operationType === 'query') {
  //               if (!key.includes('id')) {
  //                 operationType = 'unQuellable';
  //                 return BREAK;
  //               }
  //             }
  //             protoArgs[node.name.value][key] = value;
  //           }
  //         }
  //         // add value to stack
  //         stack.push(node.name.value);
  //       },
  //       leave(node) {
  //         // remove value from stack
  //         stack.pop();
  //       },
  //     },
  //     SelectionSet(node, key, parent, path, ancestors) {
  //       /* Exclude SelectionSet nodes whose parents' are not of the kind
  //        * 'Field' to exclude nodes that do not contain information about
  //        *  queried fields.
  //        */
  //       if (parent.kind === 'Field') {
  //         // loop through selections to collect fields
  //         const tempObject = {};
  //         for (let field of node.selections) {
  //           tempObject[field.name.value] = true;
  //         }

  //         // loop through stack to get correct path in proto for temp object;
  //         // mutates original prototype object;
  //         const protoObj = stack.reduce((prev, curr, index) => {
  //           return index + 1 === stack.length // if last item in path
  //             ? (prev[curr] = tempObject) // set value
  //             : (prev[curr] = prev[curr]); // otherwise, if index exists, keep value
  //         }, proto);
  //       }
  //     },
  //   });
  //   return { proto, protoArgs, operationType };
  // }

    // /**
  //  * createQueryObj traverses the prototype, removing fields that were retrieved from cache. The resulting object
  //  * will be passed to createQueryStr to construct a query requesting only the data not found in cache.
  //  * @param {Object} proto - the prototype with fields that still need to be queried toggled to false
  //  */
  // createQueryObj(proto) {
  //   const queryObj = {};
  //   for (const key in proto) {
  //     const reduced = this.protoReducer(proto[key]);
  //     if (reduced.length > 0) queryObj[key] = reduced;
  //   }
  //   return queryObj;
  // }

  // /**
  //  * protoReducer is a helper function (recusively) called from within createQueryObj, allowing introspection of
  //  * nested prototype fields.
  //  * @param {Object} proto - prototype
  //  */
  // protoReducer(proto) {
  //   const fields = [];
  //   for (const key in proto) {
  //     if (proto[key] === false) fields.push(key);
  //     if (typeof proto[key] === 'object') {
  //       const nestedObj = {};
  //       const reduced = this.protoReducer(proto[key]);
  //       if (reduced.length > 0) {
  //         nestedObj[key] = reduced;
  //         fields.push(nestedObj);
  //       }
  //     }
  //   }
  //   return fields;
  // }