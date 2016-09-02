'use strict';

const utils = require('./common/utils');
const common = require('./common/writes');
const hz_v = utils.versionField;

const {r} = require('@horizon/server');

function replace(server) {
  return (request, response, next) => {
    const conn = server.rdb_connection().connection();
    const timeout = request.getParameter('timeout');
    const collection = request.getParameter('collection');
    const permissions = request.getParameter('hz_permissions');

    if (!collection) {
      throw new Error('No collection given for insert operation.');
    } else if (!permissions) {
      throw new Error('No permissions given for insert operation.');
    }

    common.retry_loop(request.options.replace, permissions, timeout,
      (rows) => // pre-validation, all rows
        r.expr(rows.map((row) => row.id))
          .map((id) => collection.table.get(id))
          .run(conn, utils.reqlOptions),
      (validator, row, info) =>
        common.validate_old_row_required(validator, request.clientCtx, row, info, row),
      (rows) => // write to database, all valid rows
        r.expr(rows)
          .forEach((new_row) =>
            collection.table.get(new_row('id')).replace((old_row) =>
                r.branch(// The row may have been deleted between the get and now
                         old_row.eq(null),
                         r.error(common.missing_msg),

                         // The row may have been changed between the get and now
                         r.and(new_row.hasFields(hz_v),
                               old_row(hz_v).default(-1).ne(new_row(hz_v))),
                         r.error(common.invalidated_msg),

                         // Otherwise, we can safely replace the row
                         common.apply_version(
                           new_row, old_row(hz_v).default(-1).add(1))),
                {returnChanges: 'always'}))
        .run(conn, utils.reqlOptions)
    ).then((msg) => response.end(msg)).catch(next);
  };
}

module.exports = () => ({
  name: 'hz_replace',
  activate: (ctx) => ({
    methods: {
      replace: {
        type: 'terminal',
        requires: ['hz_permissions'],
        handler: replace(ctx),
      },
    },
  }),
});