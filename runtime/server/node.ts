import Boom from '@hapi/boom';
import * as Hapi from '@hapi/hapi';
import HapiInert from '@hapi/inert';
import { AbortController } from 'abort-controller';
import HapiPino from 'hapi-pino';
import Joi from 'joi';
import Module from 'module';
import type { BootstrapOptions, ServerFunction } from 'nostalgie/internals';
import * as Path from 'path';
import Pino, { Logger } from 'pino';
import type Piscina from 'piscina';

export async function startServer(
  logger: Logger,
  options: {
    buildDir: string;
    port?: number;
    host?: string;
  }
) {
  const buildDir = options.buildDir;
  const server = new Hapi.Server({
    address: options.host ?? '0.0.0.0',
    port: options.port ?? process.env.PORT ?? 8080,
    host: options.host,
  });

  const signal = wireAbortController(logger);

  signal.addEventListener('abort', () => {
    logger.info({ timeout: 60000 }, 'starting graceful server shutdown');
    server.stop({ timeout: 60000 }).catch((err) => {
      logger.error({ err }, 'error stopping server');
    });
  });

  await server.register([
    {
      plugin: HapiPino,
      options: {
        instance: logger,
        logPayload: false,
        logRequestComplete: false,
        logRequestStart: false,
      },
    },
    {
      plugin: HapiInert,
      options: {},
    },
  ]);

  server.method(
    'renderOnServer',
    async (pathname: string) => {
      if (!piscina || Math.random() >= 0) {
        const { default: renderOnServer } = await dynamicImport('./ssr.js');

        return renderOnServer(pathname);
      }

      const mc = new MessageChannel();

      mc.port2.onmessage = (...args) => {
        console.log('got rpc from piscina worker', args);
      };

      return piscina.runTask({ pathname, port: mc.port1 }, [mc.port1 as any]) as ReturnType<
        typeof import('./ssr').default
      >;
    },
    {
      cache: {
        expiresIn: 1000,
        generateTimeout: 5000,
        staleIn: 500,
        staleTimeout: 1,
      },
    }
  );

  let piscina: Piscina | undefined = undefined;

  if (Module.builtinModules.includes('worker_threads')) {
    const { default: Piscina } = await import('piscina');

    piscina = new Piscina({
      filename: Path.resolve(options.buildDir, './ssr.js'),
    });
  }

  const dynamicImport = Function('uri', 'return import(uri);');

  const serverFunctions = (await dynamicImport('./functions/functions.js')) as {
    [functionName: string]: ServerFunction | undefined;
  };

  server.route({
    method: 'POST',
    path: '/_nostalgie/rpc',
    options: {
      cors: false,
      validate: {
        payload: Joi.object({
          functionName: Joi.string().required(),
          args: Joi.array().required(),
        }),
      },
    },
    handler: async (request, h) => {
      const { functionName, args } = request.payload as { functionName: string; args: any[] };
      const serverFunction = serverFunctions[functionName];

      if (!serverFunction) {
        throw Boom.badImplementation();
      }

      const functionResult = await serverFunction({ user: null }, ...args);

      return h.response(JSON.stringify(functionResult)).type('application/json');
    },
  });

  server.route({
    method: 'GET',
    path: '/static/{path*}',
    options: {
      cache: {
        expiresIn: 30 * 1000,
        privacy: 'public',
      },
    },
    handler: {
      directory: {
        etagMethod: 'hash',
        index: false,
        listing: false,
        lookupCompressed: false,
        path: Path.join(buildDir, 'static'),
        redirectToSlash: false,
        showHidden: false,
      },
    },
  });

  server.route({
    method: 'GET',
    path: '/{any*}',
    handler: async (request, h) => {
      const { headTags, markup, preloadScripts, reactQueryState } = await (server.methods[
        'renderOnServer'
      ](request.path) as ReturnType<typeof import('./ssr').default>);
      const publicUrl = encodeURI('');

      const bootstrapOptions: BootstrapOptions = {
        lazyComponents: preloadScripts.map(([chunk, lazyImport]) => ({ chunk, lazyImport })),
        reactQueryState,
      };

      const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#000000" />
    <meta
      name="description"
      content="Web site created using nostalgie"
    />
    <link rel="apple-touch-icon" href="${publicUrl}/logo192.png" />
    ${preloadScripts.map(
      ([href]) => `<link rel="modulepreload" href="${publicUrl}/${encodeURI(href)}" />`
    )}
    <link rel="modulepreload" href="${publicUrl}/static/build/bootstrap.js" />
    ${headTags.join('\n')}
  </head>
  <body>
    <noscript>You need to enable JavaScript to run this app.</noscript>
    <div id="root">${markup}</div>
    <script type="module">
      import { start } from "${publicUrl}/static/build/bootstrap.js";

      start(${JSON.stringify(bootstrapOptions)});
    </script>
  </body>
</html>
      `.trim();

      return h.response(html).header('content-type', 'text/html');
    },
  });

  await server.start();
}

function wireAbortController(logger: Logger) {
  const abortController = new AbortController();

  const onSignal: NodeJS.SignalsListener = (signal) => {
    logger.warn({ signal }, 'signal received, shutting down');
    abortController.abort();
  };

  const onUncaughtException: NodeJS.UncaughtExceptionListener = (err) => {
    logger.fatal({ err }, 'uncaught exception, shutting down');
    abortController.abort();
  };

  const onUnhandledRejection: NodeJS.UnhandledRejectionListener = (err) => {
    logger.fatal({ err }, 'unhandled rejection, shutting down');
    abortController.abort();
  };

  process
    .once('SIGINT', onSignal)
    .once('SIGTERM', onSignal)
    .on('uncaughtException', onUncaughtException)
    .on('unhandledRejection', onUnhandledRejection);

  return abortController.signal;
}

export const logger = Pino({
  serializers: Pino.stdSerializers,
  name: '@nostalgie/server',
  prettyPrint: process.env.NODE_ENV !== 'production',
  timestamp: Pino.stdTimeFunctions.isoTime,
});

if (!require.main) {
  startServer(logger, {
    buildDir: __dirname,
  }).catch((err) => {
    logger.fatal({ err }, 'exception thrown while starting server');
  });
}
