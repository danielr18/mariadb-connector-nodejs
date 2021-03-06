"use strict";

const Connection = require("./connection");
const ConnectionCallback = require("./connection-callback");
const Queue = require("denque");
const Errors = require("./misc/errors");

function Pool(options, useCallback) {
  //*****************************************************************
  // public methods
  //*****************************************************************

  /**
   * Retrieve a connection from pool.
   * Create a new one, if limit is not reached.
   * wait until acquireTimeout.
   *
   * @return {Promise}
   */
  this.getConnection = function() {
    return handleRequest(this);
  };

  /**
   * Execute a query on one connection from pool.
   *
   * @param sql   sql command
   * @param value parameter value of sql command (not mandatory)
   * @return {Promise}
   */
  this.query = function(sql, value) {
    return handleRequest(this, sql, value);
  };

  /**
   * Close all connection in pool
   *
   * @return Promise
   */
  this.end = function() {
    if (firstTaskTimeout) clearTimeout(firstTaskTimeout);
    if (closed) {
      return Promise.reject(
        Errors.createError(
          "pool is closed",
          false,
          null,
          "HY000",
          Errors.ER_POOL_ALREADY_CLOSED,
          undefined,
          false
        )
      );
    }

    //close unused connections
    const idleConnectionsEndings = [];
    let conn;
    while ((conn = idleConnections.shift())) {
      idleConnectionsEndings.push(conn.end());
    }

    closed = true;
    taskQueue.clear();
    return Promise.all(idleConnectionsEndings);
  };

  /**
   * Get current active connections.
   * @return {number}
   */
  this.activeConnections = function() {
    return Object.keys(activeConnections).length;
  };

  /**
   * Get current total connection number.
   * @return {number}
   */
  this.totalConnections = function() {
    return this.activeConnections() + this.idleConnections();
  };

  /**
   * Get current idle connection number.
   * @return {number}
   */
  this.idleConnections = function() {
    return idleConnections.size();
  };

  /**
   * Get current stacked connection request.
   * @return {number}
   */
  this.taskQueueSize = function() {
    return taskQueue.size();
  };

  //*****************************************************************
  // internal methods
  //*****************************************************************

  /**
   * Get a connection from pool / execute query
   *
   * @param pool    current pool
   * @param sql     sql value (not mandatory)
   * @param values  sql parameter (not mandatory)
   * @return {*}
   */
  const handleRequest = function(pool, sql, values) {
    if (closed) {
      return Promise.reject(
        Errors.createError(
          "pool is closed",
          false,
          null,
          "HY000",
          Errors.ER_POOL_ALREADY_CLOSED,
          undefined,
          false
        )
      );
    }

    return getIdleValidConnection().then(
      conn => {
        if (sql) {
          return useConnection(conn, sql, values);
        }
        return Promise.resolve(conn);
      },
      () => {
        //no idle connection available
        //create a new connection if limit is not reached
        if (!connectionInCreation && opts.connectionLimit > pool.totalConnections()) {
          addConnectionToPool(this);
        }
        //connections are all used, stack demand.
        return new Promise((resolve, reject) => {
          const task = {
            timeout: Date.now() + opts.acquireTimeout,
            reject: reject,
            resolve: resolve,
            sql: sql,
            values: values
          };
          if (!firstTaskTimeout) {
            firstTaskTimeout = setTimeout(rejectAndResetTimeout, opts.acquireTimeout, task);
          }
          taskQueue.push(task);
        });
      }
    );
  };

  const getIdleValidConnection = function() {
    if (idleConnections.isEmpty()) {
      return Promise.reject(null);
    }

    const conn = idleConnections.shift();
    activeConnections[conn.threadId] = conn;
    if (opts.minDelayValidation <= 0 || Date.now() - conn.lastUse > opts.minDelayValidation) {
      if (useCallback) {
        return new Promise((resolve, reject) => {
          conn.ping(err => {
            if (err) {
              delete activeConnections[conn.threadId];
              return getIdleValidConnection();
            } else resolve(conn);
          });
        });
      } else {
        return conn
          .ping()
          .then(() => {
            return Promise.resolve(conn);
          })
          .catch(err => {
            delete activeConnections[conn.threadId];
            return getIdleValidConnection();
          });
      }
    } else {
      //just check connection state
      if (conn.isValid()) {
        return Promise.resolve(conn);
      } else {
        delete activeConnections[conn.threadId];
        return getIdleValidConnection();
      }
    }
  };

  const useConnectionPromise = function(conn, sql, values) {
    if (sql) {
      return conn
        .query(sql, values)
        .then(res => {
          conn.releaseWithoutError();
          return Promise.resolve(res);
        })
        .catch(err => {
          conn.releaseWithoutError();
          return Promise.reject(err);
        });
    } else {
      return Promise.resolve(conn);
    }
  };

  const useConnectionCallback = function(conn, sql, values) {
    if (sql) {
      return new Promise((resolve, reject) => {
        conn.query(sql, values, (err, rows, fields) => {
          conn.releaseWithoutError();
          if (err) reject(err);
          return resolve(rows);
        });
      });
    } else {
      return Promise.resolve(conn);
    }
  };

  /**
   * Task request timeout handler
   * @param task
   */
  const rejectTimeout = task => {
    firstTaskTimeout = null;
    if (task === taskQueue.peekFront()) {
      taskQueue.shift();
      const err = Errors.createError(
        "retrieve connection from pool timeout",
        false,
        null,
        "HY000",
        Errors.ER_GET_CONNECTION_TIMEOUT,
        undefined,
        false
      );
      process.nextTick(task.reject, err);
    } else {
      throw new Error("Rejection by timeout without task !!!");
    }
  };

  /**
   * Reject task, and reset timeout to next waiting task if any.
   * @param task
   */
  const rejectAndResetTimeout = task => {
    rejectTimeout(task);
    resetTimeoutToNextTask();
  };

  this.activatePool = function() {
    addConnectionToPool(this);
  };

  /**
   * Add connection to pool.
   */
  const addConnectionToPoolPromise = function(pool) {
    connectionInCreation = true;
    const conn = new Connection(opts.connOptions);
    conn
      .connect()
      .then(() => {
        if (closed) {
          conn.end().then(() => {});
        } else {
          overlayNewConnection(conn, pool, function(conn, self) {
            const initialEndFct = conn.end;
            conn.end = () => {
              return conn
                .rollback()
                .then(() => {
                  conn.lastUse = Date.now();
                  delete activeConnections[conn.threadId];
                  if (closed) {
                    initialEndFct().catch(() => {});
                  } else {
                    idleConnections.push(conn);
                    process.nextTick(handleTaskQueue.bind(self));
                  }
                  return Promise.resolve();
                })
                .catch(err => {
                  //uncertain connection state.
                  // discard it
                  delete activeConnections[conn.threadId];
                  initialEndFct().catch(() => {});
                  checkPoolSize.apply(self);
                  return Promise.resolve();
                });
            };

            //for mysql compatibility
            conn.release = conn.end;

            conn.releaseWithoutError = () => {
              conn.end().catch(() => {});
            };
          });
        }
      })
      .catch(err => {
        connectionInCreation = false;
        checkPoolSize.apply(pool);
      });
  };

  /**
   * Add connection to pool.
   */
  const addConnectionCallbackToPool = function(pool) {
    connectionInCreation = true;
    const conn = new ConnectionCallback(opts.connOptions);
    conn.connect(err => {
      if (err) {
        connectionInCreation = false;
        checkPoolSize.apply(pool);
      } else {
        if (closed) {
          //discard connection
          conn.end(() => {});
        } else {
          overlayNewConnection(conn, pool, function(conn, self) {
            const initialEndFct = conn.end;
            conn.end = function(cb) {
              conn.rollback(errCall => {
                if (errCall) {
                  //uncertain connection state.
                  delete activeConnections[conn.threadId];
                  initialEndFct(err => {});
                  checkPoolSize.apply(self);
                } else {
                  conn.lastUse = Date.now();
                  delete activeConnections[conn.threadId];
                  if (closed) {
                    initialEndFct(err => {});
                  } else {
                    idleConnections.push(conn);
                    process.nextTick(handleTaskQueue.bind(self));
                  }
                }
                if (cb) cb();
              });
            };

            //for mysql compatibility
            conn.release = conn.end;

            conn.releaseWithoutError = () => {
              conn.end(err => {});
            };
          });
        }
      }
    });
  };

  /**
   * Wrapping new connection
   *
   * @param conn  new connection
   * @param self  current pool
   */
  const overlayNewConnection = function(conn, self, fctOverlay) {
    idleConnections.push(conn);
    conn.lastUse = Date.now();
    fctOverlay(conn, self);

    const initialDestroyFct = conn.destroy;
    conn.destroy = () => {
      delete activeConnections[conn.threadId];
      initialDestroyFct();
      checkPoolSize.apply(self);
    };

    //Connection error
    // -> evict connection from pool
    conn.on("error", err => {
      let idx = 0;
      let currConn;
      delete activeConnections[conn.threadId];
      while ((currConn = idleConnections.peekAt(idx)) != undefined) {
        if (currConn === conn) {
          idleConnections.removeOne(idx);
          break;
        } else {
          //since connection did have an error, other waiting connection might too
          //forcing validation when borrowed next time, even if "minDelayValidation" is not reached.
          currConn.lastUse = new Date(0);
        }
        idx++;
      }
      checkPoolSize.apply(self);
    });
    connectionInCreation = false;

    checkPoolSize.apply(self);
    handleTaskQueue.apply(self);
  };

  /**
   * Grow pool connections until reaching connection limit.
   */
  const checkPoolSize = function() {
    if (!connectionInCreation && this.totalConnections() < opts.connectionLimit) {
      connectionInCreation = true;
      process.nextTick(addConnectionToPool, this);
    }
  };

  /**
   * Launch next waiting task request if available connections.
   */
  const handleTaskQueue = function() {
    if (firstTaskTimeout) {
      clearTimeout(firstTaskTimeout);
      firstTaskTimeout = null;
    }
    const task = taskQueue.shift();
    if (task) {
      const conn = idleConnections.shift();
      activeConnections[conn.threadId] = conn;

      resetTimeoutToNextTask();

      //handle task
      if (task.sql) {
        if (useCallback) {
          conn.query(task.sql, task.values, (err, rows, fields) => {
            conn.releaseWithoutError();
            if (err) {
              task.reject(err);
            } else {
              task.resolve(rows);
            }
          });
        } else {
          conn
            .query(task.sql, task.values)
            .then(res => {
              conn.releaseWithoutError();
              task.resolve(res);
            })
            .catch(err => {
              conn.releaseWithoutError();
              task.reject(err);
            });
        }
      } else {
        task.resolve(conn);
      }
    }
  };

  const resetTimeoutToNextTask = () => {
    //handle next Timer
    const currTime = Date.now();
    let nextTask;
    while ((nextTask = taskQueue.peekFront())) {
      if (nextTask.timeout < currTime) {
        rejectTimeout(nextTask);
      } else {
        firstTaskTimeout = setTimeout(rejectAndResetTimeout, nextTask.timeout - currTime, nextTask);
        break;
      }
    }
  };

  const opts = options;
  let closed = false;
  let connectionInCreation = false;

  const idleConnections = new Queue();
  const activeConnections = {};
  const addConnectionToPool = useCallback
    ? addConnectionCallbackToPool
    : addConnectionToPoolPromise;
  const useConnection = useCallback ? useConnectionCallback : useConnectionPromise;
  const taskQueue = new Queue();
  let firstTaskTimeout;
}

module.exports = Pool;
