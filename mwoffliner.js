#!/bin/sh
":" //# -*- mode: js -*-; exec /usr/bin/env node --max_inlined_source_size=100000 --max-old-space-size=9000 --stack-size=42000 "$0" "$@"

"use strict";

/************************************/
/* MODULE VARIABLE SECTION **********/
/************************************/

const fs = require( 'fs' );
const domino = require( 'domino' );
const async = require( 'async' );
const http = require( 'follow-redirects' ).http;
const https = require( 'follow-redirects' ).https;
const zlib = require( 'zlib' );
const urlParser = require( 'url' );
const pathParser = require( 'path' );
const homeDirExpander = require( 'expand-home-dir' );
const mkdirp = require( 'mkdirp' );
const countryLanguage = require( 'country-language' );
const redis = require( 'redis' );
const exec = require( 'child_process' ).exec;
const spawn = require( 'child_process' ).spawn;
const yargs = require( 'yargs' );
const os = require( 'os' );
const crypto = require( 'crypto' );
const unicodeCutter = require( 'utf8-binary-cutter' );
const util = require( './util' );

/************************************/
/* Command Parsing ******************/
/************************************/

const argv = yargs.usage( 'Create a fancy HTML dump of a Mediawiki instance in a directory\nUsage: $0'
	   + '\nExample: node mwoffliner.js --mwUrl=https://en.wikipedia.org/ --adminEmail=foo@bar.net' )
    .require( [ 'mwUrl', 'adminEmail' ] )
    .describe( 'mwUrl', 'Mediawiki base URL' )
    .describe( 'adminEmail', 'Email of the mwoffliner user which will be put in the HTTP user-agent string' )
    .describe( 'articleList', 'File with one title (in UTF8) per line' )
    .describe( 'cacheDirectory', 'Directory where files are permanently cached' )
    .describe( 'customZimFavicon', 'Use this option to give a path to a PNG favicon, it will be used in place of the Mediawiki logo.' )
    .describe( 'customZimTitle', 'Allow to configure a custom ZIM file title.' )
    .describe( 'customZimDescription', 'Allow to configure a custom ZIM file description.' )
    .describe( 'customMainPage', 'Allow to configure a custom page as welcome page.' )
    .describe( 'deflateTmpHtml', 'To reduce I/O, HTML pages might be deflated in tmpDirectory.' )
    .describe( 'filenamePrefix', 'For the part of the ZIM filename which is before the date part.' )
    .describe( 'format', 'To custom the output with comma separated values : "nopic,nozim"' )
    .describe( 'keepEmptyParagraphs', 'Keep all paragraphs, even empty ones.' )
    .describe( 'keepHtml', 'If ZIM built, keep the temporary HTML directory' )
    .describe( 'mwWikiPath', 'Mediawiki wiki base path (per default "/wiki/"' )
    .describe( 'mwApiPath',  'Mediawiki API path (per default "/w/api.php"' )
    .describe( 'mwDomain', 'Mediawiki user domain (thought for private wikis)' )
    .describe( 'mwUsername', 'Mediawiki username (thought for private wikis)' )
    .describe( 'mwPassword', 'Mediawiki user password (thought for private wikis)' )
    .describe( 'minifyHtml', 'Try to reduce the size of the HTML' )
    .describe( 'outputDirectory', 'Directory to write the downloaded content' )
    .describe( 'parsoidUrl', 'Mediawiki Parsoid URL' )
    .describe( 'publisher', 'ZIM publisher meta data, per default \'Kiwix\'' )
    .describe( 'redisSocket', 'Path to Redis socket file' )
    .describe( 'requestTimeout', 'Request timeout (in seconds)' )
    .describe( 'resume', 'Do not overwrite if ZIM file already created' )
    .describe( 'skipHtmlCache', 'Do not cache Parsoid HTML output (and do not use any cached HTML content)' )
    .describe( 'skipCacheCleaning', 'Do not search for old/outdated files in the cache' )
    .describe( 'speed', 'Multiplicator for the number of parallel HTTP requests on Parsoid backend (per default the number of CPU cores). The default value is 1.' )
    .describe( 'tmpDirectory', 'Directory where files are temporary stored' )
    .describe( 'verbose', 'Print debug information to the stdout' )
    .describe( 'withZimFullTextIndex', 'Include a fulltext search index to the ZIM' )
    .describe( 'writeHtmlRedirects', 'Write redirect as HTML files' )
    .strict()
    .argv;

/************************************/
/* CUSTOM VARIABLE SECTION **********/
/************************************/

/* Formats */
let dumps = [ '' ];
if ( argv.format ) {
    if (argv.format instanceof Array) {
        dumps = [];
        argv.format.forEach(function (value) {
            dumps.push(value == true ? '' : value);
        });
    } else if (argv.format != true) {
        dumps = [argv.format];
    }
}

/* Template code for any redirect to be written on the FS */
const redirectTemplateCode = '<html><head><meta charset="UTF-8" /><title>{{ title }}</title><meta http-equiv="refresh" content="0; URL={{ target }}"></head><body></body></html>';

/* All DOM nodes with on of these styles will be removed */
/* On Wikivoyage 'noprint' remove also top banners like on 'South America'. */
const cssClassBlackList = [ 'noprint', 'metadata', 'ambox', 'stub', 'topicon', 'magnify', 'navbar', 'mwe-math-mathml-inline' ];

/* All DOM node with these styles will be deleted if no A node is included in the sub-tree */
const cssClassBlackListIfNoLink = [ 'mainarticle', 'seealso', 'dablink', 'rellink', 'hatnote' ];

/* All DOM nodes which we should for to display */
const cssClassDisplayList = [ 'thumb' ];

/* List of style to be removed */
const cssClassCallsBlackList = [ 'plainlinks' ];

/* All nodes with one of these ids will be remove */
const idBlackList = [ 'purgelink' ];

/* HTTP user-agent string */
let adminEmail = argv.adminEmail;
let userAgentString = 'MWOffliner/HEAD';
if ( util.validateEmail( adminEmail ) ) {
    userAgentString += ' (' + adminEmail + ')';
} else {
    printErr('Admin email ' + adminEmail + ' is not valid');
    process.exit(1);
}
let loginCookie = '';

/* Directory wehre everything is saved at the end of the process */
let outputDirectory = argv.outputDirectory ? homeDirExpander( argv.outputDirectory ) + '/' : 'out/';

/* Directory where temporary data are saved */
let tmpDirectory = argv.tmpDirectory ? homeDirExpander( argv.tmpDirectory ) + '/' : 'tmp/';
let deflateTmpHtml = argv.deflateTmpHtml;

/* Parsoid URL */
let parsoidUrl = argv.parsoidUrl;

/* ZIM custom Favicon */
let customZimFavicon = argv.customZimFavicon;
if ( customZimFavicon && !fs.existsSync( customZimFavicon ) ) {
    printErr('Path "' + customZimFavicon + '" is not a valid PNG file.');
    process.exit(1);
}

/* If ZIM is built, should temporary HTML directory be kept */
let keepHtml = argv.keepHtml;

/* List of articles is maybe in a file */
let articleList = argv.articleList;

/* Prefix part of the filename (radical) */
let filenamePrefix = argv.filenamePrefix || '';

/* Number of parallel requests */
let cpuCount = os.cpus().length;
if ( argv.speed && isNaN( argv.speed ) ) {
    printErr('speed is not a number, please give a number value to --speed');
    process.exit(1);
}
let speed = cpuCount * ( argv.speed || 1 );

/* Necessary to avoid problems with https */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/* Verbose */
let verbose = argv.verbose;

/* Optimize HTML */
let minifyHtml = argv.minifyHtml;

/* How to write redirects */
let writeHtmlRedirects = argv.writeHtmlRedirects;

/* File where redirects might be save if --writeHtmlRedirects is not set */
let redirectsCacheFile;

/* Cache strategy */
let skipHtmlCache = argv.skipHtmlCache;
let skipCacheCleaning = argv.skipCacheCleaning;

/* Should we keep ZIM file generation if ZIM file already exists */
let resume = argv.resume;

/* Path to a Redis socket */
let redisSocket = argv.redisSocket ? argv.redisSocket : '/dev/shm/redis.sock';

/* Default request timeout */
let requestTimeout = argv.requestTimeout ? argv.requestTimeout : 60;

/* Keep empty paragraphs */
let keepEmptyParagraphs = argv.keepEmptyParagraphs;

/* Include fulltext index in ZIM file */
let withZimFullTextIndex = argv.withZimFullTextIndex;

/* ZIM publisher */
let publisher = argv.publisher || 'Wikimedia Foundation';

/* Wikipedia/... URL */
let mwUrl = argv.mwUrl;
let hostParts = urlParser.parse( mwUrl ).hostname.split( '.' );

/* ZIM (content) creator */
let creator = hostParts[0];
if ( hostParts.length > 1 ) {
    creator =
        hostParts[1] != 'wikipedia' &&
        hostParts[1] != 'wikisource' &&
        hostParts[1] != 'wikibooks' &&
        hostParts[1] != 'wikiquote' &&
        hostParts[1] != 'wikivoyage' &&
        hostParts[1] != 'wikiversity' &&
        hostParts[1] != 'wikinews' &&
        hostParts[1] != 'wiktionary' &&
        hostParts[0].length > hostParts[1].length
            ? hostParts[0] : hostParts[1];
}
creator = creator.charAt(0).toUpperCase() + creator.substr( 1 );

/* Namespaces to mirror */
let namespacesToMirror = [];

/* License footer template code */
const footerTemplateCode = '<div style="clear:both; background-image:linear-gradient(180deg, #E8E8E8, white); border-top: dashed 2px #AAAAAA; padding: 0.5em 0.5em 2em 0.5em; margin-top: 1em; direction: ltr;">This article is issued from <a class="external text" href="{{ webUrl }}{{ articleId }}?oldid={{ oldId }}">{{ creator }}</a>{% if date %} - version of the {{ date }}{% endif %}. The text is available under the <a class="external text" href="http://creativecommons.org/licenses/by-sa/3.0/">Creative Commons Attribution/Share Alike</a> but additional terms may apply for the media files.</div>';

/************************************/
/* CONSTANT VARIABLE SECTION ********/
/************************************/

let styleDirectory = 's';
let mediaDirectory = 'm';
let javascriptDirectory = 'j';
let mediaRegex = /^(.*\/)([^\/]+)(\/)(\d+px-|)(.+?)(\.[A-Za-z0-9]{2,6}|)(\.[A-Za-z0-9]{2,6}|)$/;
let htmlTemplateCode = function(){/*
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title></title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="s/style.css" />
    <script src="j/head.js"></script>
  </head>
  <body class="mw-body mw-body-content mediawiki" style="background-color: white; margin: 0; border-width: 0px; padding: 0px;">
    <div id="content" class="mw-body" style="padding: 1em; border-width: 0px; max-width: 55.8em; margin: 0 auto 0 auto">
      <a id="top"></a>
      <h1 id="titleHeading" style="background-color: white; margin: 0;"></h1>
      <div id="mw-content-text">
      </div>
    </div>
    <script src="j/body.js"></script>
  </body>
</html>
*/}.toString().slice(14,-3);

/************************************/
/* SYSTEM VARIABLE SECTION **********/
/************************************/

let INFINITY_WIDTH = 9999999;
let ltr = true;
let autoAlign = ltr ? 'left' : 'right';
let revAutoAlign = ltr ? 'right' : 'left';
let subTitle = '';
let langIso2 = 'en';
let langIso3 = 'eng';
let name = argv.customZimTitle || '';
let description = argv.customZimDescription || '';
let mainPageId = argv.customMainPage || '';
let articleIds = {};
let namespaces = {};
let mwWikiPath = argv.mwWikiPath !== undefined && argv.mwWikiPath !== true ? argv.mwWikiPath : 'wiki';
let webUrl = mwUrl + mwWikiPath + '/';
let webUrlHost =  urlParser.parse( webUrl ).host;
let webUrlPath = urlParser.parse( webUrl ).pathname;
let webUrlPort = getRequestOptionsFromUrl( webUrl ).port;
let mwApiPath = argv.mwApiPath || 'w/api.php';
let apiUrl = mwUrl + mwApiPath + '?';

if ( !parsoidUrl ) {
    parsoidUrl = apiUrl + "action=visualeditor&format=json&paction=parse&page=";
}

let nopic = false;
let nozim = false;
let filenameRadical = '';
let htmlRootPath = '';
let cacheDirectory = ( argv.cacheDirectory ? argv.cacheDirectory : pathParser.resolve( process.cwd(), 'cac' ) ) + '/';
let mwUsername = argv.mwUsername || '';
let mwDomain = argv.mwDomain || '';
let mwPassword = argv.mwPassword || '';

/************************************/
/* CONTENT DATE *********************/
/************************************/

let date = new Date();
let contentDate = date.getFullYear() + '-' + ( '0' + ( date.getMonth() + 1 ) ).slice( -2 );

/************************************/
/* RUNNING CODE *********************/
/************************************/

/* Check if opt. binaries are available */
let optBinaries = [ 'jpegoptim --version', 'pngquant --version', 'gifsicle --version', 'advdef --version', 'file --help', 'stat --version', 'convert --version' ];
try {
    dumps.forEach(function (dump) {
        if (dump.toLowerCase().indexOf('nozim') < 0) {
            optBinaries.push('zimwriterfs --help');
            throw BreakException;
        }
    });
} catch(e) {
}
optBinaries.forEach( function( cmd ) {
    exec(cmd, function (error, stdout, stderr) {
        if (error) {
            printErr('Failed to find binary "' + cmd.split(' ')[0] + '": (' + error + ')');
            process.exit(1);
        }
    }, true, true);
});

/* Setup redis client */
let redisClient = redis.createClient( redisSocket );
let redisNamePrefix = (new Date).getTime();
let redisRedirectsDatabase = redisNamePrefix + 'r';
let redisMediaIdsDatabase = redisNamePrefix + 'm';
let redisArticleDetailsDatabase = redisNamePrefix + 'd';
let redisCachedMediaToCheckDatabase = redisNamePrefix + 'c';

/* Get content */
async.series(
    [
	function( finished ) { login( finished ) },
	function( finished ) { getTextDirection( finished ) },
	function( finished ) { getSiteInfo( finished ) },
	function( finished ) { getSubTitle( finished ) },
	function( finished ) { getNamespaces( finished ) },
	function( finished ) { createDirectories( finished ) },
	function( finished ) { prepareCache( finished ) },
	function( finished ) { checkResume( finished ) },
	function( finished ) { getArticleIds( finished ) },
	function( finished ) { cacheRedirects( finished ) },
	function( finished ) {
        async.eachSeries(
            dumps,
            function (dump, finished) {
                printLog('Starting a new dump...');
                nopic = dump.toString().search('nopic') >= 0;
                nozim = dump.toString().search('nozim') >= 0;
                keepHtml = nozim ? true : keepHtml;
                filenameRadical = computeFilenameRadical();
                htmlRootPath = computeHtmlRootPath();

                async.series(
                    [
                        function (finished) {
                            createSubDirectories(finished)
                        },
                        function (finished) {
                            saveFavicon(finished)
                        },
                        function (finished) {
                            getMainPage(finished)
                        },
                        function (finished) {
                            writeHtmlRedirects ? saveHtmlRedirects(finished) : finished()
                        },
                        function (finished) {
                            saveArticles(finished)
                        },
                        function (finished) {
                            drainDownloadFileQueue(finished)
                        },
                        function (finished) {
                            drainOptimizationQueue(finished)
                        },
                        function (finished) {
                            buildZIM(finished)
                        },
                        function (finished) {
                            endProcess(finished)
                        }
                    ],
                    function (error, result) {
                        finished();
                    });
            },
            function (error) {
                async.series(
                    [
                        function (finished) {
                            if (skipCacheCleaning) {
                                printLog('Skipping cache cleaning...');
                                exec('rm -f "' + cacheDirectory + 'ref"', finished);
                            } else {
                                printLog('Cleaning cache');
                                exec('find "' + cacheDirectory + '" -type f -not -newer "' + cacheDirectory + 'ref" -exec rm {} \\;', finished);
                            }
                        }
                    ],
                    function (error, result) {
                        finished();
                    });
            }
        )
    }
    ],
    function( error ) {
        async.series(
            [
                function (finished) {
                    printLog('Flushing redis databases...');
                    redisClient.del(redisRedirectsDatabase, redisMediaIdsDatabase, redisArticleDetailsDatabase, redisCachedMediaToCheckDatabase, function () {
                        printLog('Redis databases flushed.');
                        finished();
                    })
                },
                function (finished) {
                    printLog('Quitting redis databases...');
                    redisClient.quit();
                    printLog('Closing HTTP agents...');
                    closeAgents();
                    finished();
                }
            ],
            function (error, result) {
                printLog('All dump(s) finished with success.');

                /* Time to time the script hungs here. Forcing the exit */
                process.exit(0);
            }
        )
    }
);

/************************************/
/* MEDIA RELATED QUEUES *************/
/************************************/

/* Setting up media optimization queue */
const optimizationQueue = async.queue( function ( file, finished ) {
    let path = file.path;

    function getOptimizationCommand(path, forcedType) {
        let ext = pathParser.extname(path).split('.')[1] || '';
        let basename = path.substring(0, path.length - ext.length - 1) || '';
        let tmpExt = '.' + util.randomString(5) + '.' + ext;
        let tmpPath = basename + tmpExt;
        let type = forcedType || ext;

        /* Escape paths */
        path = path.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
        tmpPath = tmpPath.replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');

        if (type === 'jpg' || type === 'jpeg' || type === 'JPG' || type === 'JPEG') {
            return 'jpegoptim -s -f --all-normal -m40 "' + path + '"';
        } else if (type === 'png' || type === 'PNG') {
            return 'pngquant --verbose --nofs --force --ext="' + tmpExt + '" "' + path +
                '" && advdef -q -z -4 -i 5 "' + tmpPath +
                '" && if [ $(stat -c%s "' + tmpPath + '") -lt $(stat -c%s "' + path + '") ]; then mv "' + tmpPath + '" "' + path + '"; else rm "' + tmpPath + '"; fi';
        } else if (type === 'gif' || type === 'GIF') {
            return 'gifsicle --verbose --colors 64 -O3 "' + path + '" -o "' + tmpPath +
                '" && if [ $(stat -c%s "' + tmpPath + '") -lt $(stat -c%s "' + path + '") ]; then mv "' + tmpPath + '" "' + path + '"; else rm "' + tmpPath + '"; fi';
        }
    }

    if (path) {
        fs.stat(path, function (error, stats) {
            if (!error && stats.size == file.size) {
                let cmd = getOptimizationCommand(path);

                if (cmd) {
                    async.retry(5,
                        function (finished, skip) {
                            exec(cmd, function (executionError, stdout, stderr) {
                                if (executionError) {
                                    fs.stat(path, function (error, stats) {
                                        if (!error && stats.size > file.size) {
                                            finished(null, true);
                                        } else if (!error && stats.size < file.size) {
                                            finished('File to optimize is smaller (before optimization) than it should be.');
                                        } else {
                                            exec('file -b --mime-type "' + path + '"', function (error, stdout, stderr) {
                                                let type = stdout.replace(/image\//, '').replace(/[\n\r]/g, '');
                                                cmd = getOptimizationCommand(path, type);

                                                if (cmd) {
                                                    setTimeout(finished, 2000, executionError);
                                                } else {
                                                    finished('Unable to find optimization command.');
                                                }
                                            });
                                        }
                                    });
                                } else {
                                    finished();
                                }
                            });
                        },
                        function (error, skip) {
                            if (error) {
                                printErr('Executing command : ' + cmd);
                                printErr('Failed to optimize ' + path + ', with size=' + file.size + ' (' + error + ')');
                            } else if (skip) {
                                printLog('Optimization skipped for ' + path + ', with size=' + file.size + ', a better version was downloaded meanwhile.');
                            } else {
                                printLog('Successfully optimized ' + path);
                            }
                            finished();
                        }
                    );
                } else {
                    finished();
                }
            } else {
                printErr('Failed to start to optimize ' + path + '. Size should be ' + file.size +
                    ' (' + ( error ? 'file was probably deleted; error: ' +
                        error : ( stats ? stats.size : 'No stats information' ) ) + ')');
                finished();
            }
        });
    } else {
        finished();
    }

}, cpuCount * 2 );

/* Setting up the downloading queue */
const downloadFileQueue = async.queue( function ( url, finished ) {
    if (url) {
        downloadFileAndCache(url, finished);
    } else {
        finished();
    }
}, speed * 5 );

/************************************/
/* FUNCTIONS ************************/
/************************************/

function login( finished ) {
    if (mwUsername != '' && mwPassword != '') {
        let url = apiUrl + 'action=login&format=json&lgname=' + mwUsername + '&lgpassword=' + mwPassword;
        if (mwDomain != '') {
            url = url + '&lgdomain=' + mwDomain;
        }

        downloadContent(url, function (content) {
            let body = content.toString();
            let jsonResponse = JSON.parse(body)['login'];
            loginCookie = jsonResponse['cookieprefix'] + '_session=' + jsonResponse['sessionid'];

            if (jsonResponse['result'] == 'SUCCESS') {
                finished();
            } else {
                url = url + '&lgtoken=' + jsonResponse['token'];
                downloadContent(url, function (content) {
                    body = content.toString();
                    jsonResponse = JSON.parse(body)['login'];

                    if (jsonResponse['result'] == 'Success') {
                        loginCookie = jsonResponse['cookieprefix'] + '_session=' + jsonResponse['sessionid'];
                        finished();
                    } else {
                        printErr('Login failed');
                        process.exit(1);
                    }
                });
            }
        });
    } else {
        finished();
    }
}

function checkResume( finished ) {
    for (let i = 0; i < dumps.length; i++) {
        let dump = dumps[i];
        nopic = dump.toString().search('nopic') >= 0;
        nozim = dump.toString().search('nozim') >= 0;
        htmlRootPath = computeHtmlRootPath();

        if (resume && !nozim) {
            let zimPath = computeZimRootPath();
            if (fs.existsSync(zimPath)) {
                printLog(zimPath + ' is already done, skip dumping & ZIM file generation');
                dumps.splice(i, 1);
                i--;
            }
        }
    }
    finished(dumps.length <= 0);
}

function closeAgents( finished ) {
    http.globalAgent.destroy();
    https.globalAgent.destroy();
    if (finished) {
        finished();
    }
}

function prepareCache( finished ) {
    printLog('Preparing cache...');
    cacheDirectory = cacheDirectory + computeFilenameRadical(true, true, true) + '/';
    redirectsCacheFile = computeRedirectsCacheFilePath();
    mkdirp(cacheDirectory + 'm/', function () {
        fs.writeFileSync(cacheDirectory + 'ref', '42');
        finished();
    });

}

function createDirectories( finished ) {
    printLog('Creating base directories...');
    async.series(
        [
            function (finished) {
                mkdirp(outputDirectory, finished)
            },
            function (finished) {
                mkdirp(tmpDirectory, finished)
            }
        ],
        function (error) {
            if (error) {
                printErr('Unable to create mandatory directories : ' + error);
                process.exit(1);
            } else {
                finished();
            }
        });
}

function extractTargetIdFromHref( href ) {
    try {
        let pathname = urlParser.parse(href, false, true).pathname || '';
        if (pathname.indexOf('./') == 0) {
            return util.myDecodeURIComponent(pathname.substr(2));
        } else if (pathname.indexOf(webUrlPath) == 0) {
            return util.myDecodeURIComponent(pathname.substr(webUrlPath.length));
        }
    } catch (error) {
        printErr('Unable to parse href ' + href);
        return '';
    }
}

function computeFilenameRadical( withoutSelection, withoutPictureStatus, withoutDate ) {
    let radical;

    if (filenamePrefix) {
        radical = filenamePrefix;
    } else {
        radical = creator.charAt(0).toLowerCase() + creator.substr(1) + '_';
        let hostParts = urlParser.parse(webUrl).hostname.split('.');
        let langSuffix = langIso2;
        for (let i = 0; i < hostParts.length; i++) {
            if (hostParts[i] === langIso3) {
                langSuffix = hostParts[i];
                break;
            }
        }
        radical += langSuffix;
    }

    if (!withoutSelection) {
        if (articleList) {
            radical += '_' + pathParser.basename(articleList, pathParser.extname(articleList)).toLowerCase().replace(/ /g, '_');
        } else {
            radical += '_all';
        }
    }

    if (!withoutPictureStatus) {
        radical += nopic ? '_nopic' : '';
    }

    if (!withoutDate) {
        radical += '_' + contentDate;
    }

    return radical;
}

function computeHtmlRootPath() {
    let htmlRootPath;

    if (nozim) {
        htmlRootPath = outputDirectory[0] === '/' ? outputDirectory : pathParser.resolve(process.cwd(), tmpDirectory) + '/';
    } else {
        htmlRootPath = tmpDirectory[0] === '/' ? tmpDirectory : pathParser.resolve(process.cwd(), tmpDirectory) + '/';
    }

    htmlRootPath += computeFilenameRadical() + '/';
    return htmlRootPath;
}

function computeZimRootPath() {
    let zimRootPath = outputDirectory[0] === '/' ? outputDirectory : pathParser.resolve(process.cwd(), outputDirectory) + '/';
    zimRootPath += computeFilenameRadical() + '.zim';
    return zimRootPath;
}

function computeZimName() {
    return (publisher ? publisher.toLowerCase() + '.' : '' ) + computeFilenameRadical(false, true, true);
}

function computeRedirectsCacheFilePath() {
    return cacheDirectory + computeFilenameRadical(false, true, true) + '.redirects';
}

function buildZIM( finished ) {
    if (!nozim) {
        exec('sync', function (error) {
            let zimPath = computeZimRootPath();
            let cmd = 'zimwriterfs --welcome=index.htm --favicon=favicon.png --language=' + langIso3
                + ( mainPageId ? '--welcome=' + getArticleBase(mainPageId) : '--welcome=index.htm' )
                + ( deflateTmpHtml ? ' --inflateHtml ' : '' )
                + ( verbose ? ' --verbose ' : '' )
                + ( nopic ? ' --tags=nopic' : '' )
                + ' --name="' + computeZimName() + '"'
                + ( withZimFullTextIndex ? ' --withFullTextIndex' : '' )
                + ( writeHtmlRedirects ? '' : ' --redirects="' + redirectsCacheFile + '"' )
                + ' --title="' + name + '" --description="' + ( description || subTitle || name ) + '" --creator="' + creator + '" --publisher="'
                + publisher + '" "' + htmlRootPath + '" "' + zimPath + '"';
            printLog('Building ZIM file ' + zimPath + ' (' + cmd + ')...');
            printLog('RAID: ' + computeZimName());
            executeTransparently('zimwriterfs',
                [deflateTmpHtml ? '--inflateHtml' : '',
                    verbose ? '--verbose' : '',
                    writeHtmlRedirects ? '' : '--redirects=' + redirectsCacheFile,
                    withZimFullTextIndex ? '--withFullTextIndex' : '',
                    nopic ? '--tags=nopic' : '',
                    mainPageId ? '--welcome=' + getArticleBase(mainPageId) : '--welcome=index.htm',
                    '--minChunkSize=512',
                    '--favicon=favicon.png',
                    '--language=' + langIso3,
                    '--title=' + name,
                    '--name=' + computeZimName(),
                    '--description=' + ( description || subTitle || name ),
                    '--creator=' + creator,
                    '--publisher=' + publisher,
                    htmlRootPath,
                    zimPath],
                function (error) {
                    if (error) {
                        printErr('Failed to build successfully the ZIM file ' + zimPath + ' (' + error + ')');
                        process.exit(1);
                    } else {
                        printLog('ZIM file built at ' + zimPath);
                    }

                    /* Delete the html directory ? */
                    if (keepHtml) {
                        finished();
                    } else {
                        exec('rm -rf \"' + htmlRootPath + '\"', finished);
                    }
                }, !verbose, !verbose);
        }).on('error', function (error) {
            printErr(error)
        });
    } else {
        finished();
    }
}

function endProcess( finished ) {
    printLog('Dump finished with success.');
    redisClient.del(redisMediaIdsDatabase, finished);
}

function drainDownloadFileQueue( finished ) {
    printLog(downloadFileQueue.length() + " images still to be downloaded.");
    async.doWhilst(
        function (finished) {
            if (downloadFileQueue.idle()) {
                printLog('Process still downloading images...');
            }
            setTimeout(finished, 1000);
        },
        function () {
            return !downloadFileQueue.idle()
        },
        function (error) {
            let drainBackup = downloadFileQueue.drain;
            downloadFileQueue.drain = function (error) {
                if (error) {
                    printErr('Error downloading images' + error);
                    process.exit(1);
                } else {
                    if (downloadFileQueue.length() == 0) {
                        printLog('All images successfully downloaded');
                        downloadFileQueue.drain = drainBackup;
                        finished();
                    }
                }
            };
            downloadFileQueue.push('');
        });
}

function drainOptimizationQueue( finished ) {
    printLog(optimizationQueue.length() + ' images still to be optimized.');
    async.doWhilst(
        function (finished) {
            if (optimizationQueue.idle()) {
                printLog('Process still being optimizing images...');
            }
            setTimeout(finished, 1000);
        },
        function () {
            return !optimizationQueue.idle()
        },
        function (error) {
            let drainBackup = optimizationQueue.drain;
            optimizationQueue.drain = function (error) {
                if (error) {
                    printErr('Error optimizing images' + error);
                    process.exit(1);
                } else {
                    if (optimizationQueue.length() == 0) {
                        printLog('All images successfully optimized');
                        optimizationQueue.drain = drainBackup;
                        finished();
                    }
                }
            };
            optimizationQueue.push({path: '', size: 0});
        });
}

function cacheRedirects( finished ) {
    printLog('Reset redirects cache file (or create it)');
    fs.openSync(redirectsCacheFile, 'w');

    printLog('Caching redirects...');
    function cacheRedirect(redirectId, finished) {
        redisClient.hget(redisRedirectsDatabase, redirectId, function (error, target) {
            if (error) {
                printErr('Unable to get a redirect target from redis for caching: ' + error);
                process.exit(1);
            } else {
                if (target) {
                    printLog('Caching redirect ' + redirectId + ' (to ' + target + ')...');
                    let line = 'A\t' + getArticleBase(redirectId) + '\t' + redirectId.replace(/_/g, ' ') +
                        '\t' + getArticleBase(target, false) + '\n';
                    fs.appendFile(redirectsCacheFile, line, finished);
                } else {
                    finished();
                }
            }
        });
    }

    redisClient.hkeys(redisRedirectsDatabase, function (error, keys) {
        if (error) {
            printErr('Unable to get redirect keys from redis for caching: ' + error);
            process.exit(1);
        } else {
            async.eachLimit(keys, speed, cacheRedirect, function (error) {
                if (error) {
                    printErr('Unable to cache a redirect: ' + error);
                    process.exit(1);
                } else {
                    printLog('All redirects cached successfully.');
                    finished();
                }
            });
        }
    });
}

function saveHtmlRedirects( finished ) {
    printLog('Saving HTML redirects...');

    function saveHtmlRedirect(redirectId, finished) {
        redisClient.hget(redisRedirectsDatabase, redirectId, function (error, target) {
            if (error) {
                printErr('Unable to get a redirect target from redis for saving: ' + error);
                process.exit(1);
            } else {
                if (target) {
                    printLog('Writing HTML redirect ' + redirectId + ' (to ' + target + ')...');
                    let data = redirectTemplateCode.replace("{{ title }}", redirectId.replace(/_/g, ' ')).replace("{{ target }}", getArticleUrl(target));
                    if (deflateTmpHtml) {
                        zlib.deflate(data, function (error, deflatedHtml) {
                            fs.writeFile(getArticlePath(redirectId), deflatedHtml, finished);
                        });
                    } else {
                        fs.writeFile(getArticlePath(redirectId), data, finished);
                    }
                } else {
                    finished();
                }
            }
        });
    }

    redisClient.hkeys(redisRedirectsDatabase, function (error, keys) {
        if (error) {
            printErr('Unable to get redirect keys from redis for saving: ' + error);
            process.exit(1);
        } else {
            async.eachLimit(keys, speed, saveHtmlRedirect, function (error) {
                if (error) {
                    printErr('Unable to save a HTML redirect: ' + error);
                    process.exit(1);
                } else {
                    printLog('All redirects were saved successfully as HTML files.');
                    finished();
                }
            });
        }
    });
}

function saveArticles( finished ) {

    function transformSections(json) {

        // rewrite and download lead image URLs
        transformLeadProperties(json['lead']);

        json['lead']['sections'][0]['text'] = transformSection(domino.createDocument(json['lead']['sections'][0]['text']));

        for (let i = 0; i < json['remaining']['sections'].length; i++) {
            json['remaining']['sections'][i]['text'] = transformSection(domino.createDocument(json['remaining']['sections'][i]['text']));
        }
    }

    function transformLeadProperties(json) {
        if (!json) {
            return;
        }
        if (json['image']) {
            for (let url in json['image']['urls']) {
                let src = getFullUrl(json['image']['urls'][url]);
                let newSrc = getMediaUrl(src);
                if (newSrc) {
                    downloadFileQueue.push(src);
                    json['image']['urls'][url] = newSrc;
                }
            }
        }
        if (json['pronunciation']) {
            let src = getFullUrl(json['pronunciation']['url']);
            let newSrc = getMediaUrl(src);
            if (newSrc) {
                downloadFileQueue.push(src);
                json['pronunciation']['url'] = newSrc;
            }
        }
    }

    function transformSection(dom) {
        treatMediaElementsForSection(dom);
        rewriteUrls(dom);
        applyOtherTreatments(dom);

        return dom.body.innerHTML;
    }

    function treatMediaElementsForSection(dom) {
        /* Clean/rewrite image tags */
        const imgs = dom.getElementsByTagName('img');
        let imgSrcCache = {};

        for (let i = 0; i < imgs.length; i++) {
            let img = imgs[i];
            let imageNodeClass = img.getAttribute('class') || '';

            if ((!nopic ||
                    imageNodeClass.search('mwe-math-fallback-image-inline') >= 0 ||
                    img.getAttribute('typeof') == 'mw:Extension/math'
                ) &&
                img.getAttribute('src') &&
                img.getAttribute('src').indexOf('./Special:FilePath/') != 0
            ) {

                /* Remove image link */
                let linkNode = img.parentNode;
                if (linkNode.tagName === 'A') {

                    /* Check if the target is mirrored */
                    let href = linkNode.getAttribute('href') || '';
                    let targetId = extractTargetIdFromHref(href);
                    let keepLink = targetId && isMirrored(targetId);

                    /* Under certain condition it seems that this is possible
                     * to have parentNode == undefined, in this case this
                     * seems preferable to remove the whole link+content than
                     * keeping a wrong link. See for example this url
                     * http://parsoid.wmflabs.org/ko/%EC%9D%B4%ED%9C%98%EC%86%8C */
                    if (!keepLink) {
                        if (linkNode.parentNode) {
                            linkNode.parentNode.replaceChild(img, linkNode);
                        } else {
                            util.deleteNode(img);
                        }
                    }
                }

                /* Rewrite image src attribute */
                if (img) {
                    let src = getFullUrl(img.getAttribute('src'));
                    let newSrc = getMediaUrl(src);

                    if (newSrc) {

                        /* Download image, but avoid duplicate calls */
                        if (!imgSrcCache.hasOwnProperty(src)) {
                            imgSrcCache[src] = true;
                            downloadFileQueue.push(src);
                        }

                        /* Change image source attribute to point to the local image */
                        img.setAttribute('src', newSrc);

                        /* Remove useless 'resource' attribute */
                        img.removeAttribute('resource');

                        /* Remove srcset */
                        img.removeAttribute('srcset');
                    } else {
                        util.deleteNode(img);
                    }
                }
            } else {
                util.deleteNode(img);
            }
        }
    }

    function rewriteUrls(dom) {

        function rewriteUrl(linkNode) {
            let href = linkNode.getAttribute('href');
            if (!href) {
                return;
            }

            // Deal with custom geo. URL replacement, for example:
            // http://maps.wikivoyage-ev.org/w/poimap2.php?lat=44.5044943&lon=34.1969633&zoom=15&layer=M&lang=ru&name=%D0%9C%D0%B0%D1%81%D1%81%D0%B0%D0%BD%D0%B4%D1%80%D0%B0
            // http://tools.wmflabs.org/geohack/geohack.php?language=fr&pagename=Tour_Eiffel&params=48.85825_N_2.2945_E_type:landmark_region:fr
            let lat, lon;
            if (/poimap2\.php/i.test(href)) {
                let hrefQuery = urlParser.parse(href, true).query;
                lat = parseFloat(hrefQuery.lat);
                lon = parseFloat(hrefQuery.lon);
            } else if (/geohack\.php/i.test(href)) {
                let params = urlParser.parse(href, true).query.params;

                // "params" might be an array, try to detect the geo localization one
                if (params instanceof Array) {
                    let i = 0;
                    while (params[i] && isNaN(params[i][0])) {
                        i++
                    }
                    params = params[i];
                }

                if (params) {
                    // see https://bitbucket.org/magnusmanske/geohack/src public_html geo_param.php
                    let pieces = params.toUpperCase().split('_');
                    let semiPieces = pieces.length > 0 ? pieces[0].split(';') : undefined;
                    if (semiPieces && semiPieces.length == 2) {
                        lat = semiPieces[0];
                        lon = semiPieces[1];
                    } else {
                        let factors = [1, 60, 3600];
                        let offs = 0;

                        let deg = function (hemiHash) {
                            let out = 0;
                            let hemiSign = 1;
                            for (let i = 0; i < 4 && (i + offs) < pieces.length; i++) {
                                let v = pieces[i + offs];
                                let hemiSign = hemiHash[v];
                                if (hemiSign) {
                                    offs = i + 1;
                                    break;
                                }
                                out += v / factors[i];
                            }
                            return out * hemiSign;
                        };

                        lat = deg({N: 1, S: -1});
                        lon = deg({E: 1, W: -1, O: 1});
                    }
                }
            }

            if (!isNaN(lat) && !isNaN(lon)) {
                href = 'geo:' + lat + ',' + lon;
                linkNode.setAttribute('href', href);
            }

            /*
            let targetId = extractTargetIdFromHref(href);
            if (targetId) {
                if (isMirrored(targetId)) {
                    //linkNode.setAttribute('href', getArticleUrl(targetId));
                } else {
                    redisClient.hexists(redisRedirectsDatabase, targetId, function (error, res) {
                        if (error) {
                            printErr('Unable to check redirect existence with redis: ' + error);
                            process.exit(1);
                        } else {
                            if (res) {
                                //linkNode.setAttribute('href', getArticleUrl(targetId));
                            } else {
                                linkNode.setAttribute('href', 'foo');
                            }
                        }
                    });
                }
            }
            */
        }

        /* Go through all links */
        let as = dom.getElementsByTagName('a');
        let areas = dom.getElementsByTagName('area');
        let linkNodes = Array.prototype.slice.call(as).concat(Array.prototype.slice.call(areas));

        for (let i = 0; i < linkNodes.length; i++) {
            rewriteUrl(linkNodes[i]);
        }
    }

    function applyOtherTreatments(dom) {
        // Remove "map" tags if necessary
        if (nopic) {
            let maps = dom.getElementsByTagName('map');
            for (let i = 0; i < maps.length; i++) {
                util.deleteNode(maps[i]);
            }
        }

        // Remove elements with id in the blacklist
        idBlackList.map(function (id) {
            let node = dom.getElementById(id);
            if (node) {
                util.deleteNode(node);
            }
        });

        // Remove elements with blacklisted CSS classes
        cssClassBlackList.map(function (classname) {
            let nodes = dom.getElementsByClassName(classname);
            for (let i = 0; i < nodes.length; i++) {
                util.deleteNode(nodes[i]);
            }
        });

        // Remove elements with blacklisted CSS classes and no link
        cssClassBlackListIfNoLink.map(function (classname) {
            let nodes = dom.getElementsByClassName(classname);
            for (let i = 0; i < nodes.length; i++) {
                if (nodes[i].getElementsByTagName('a').length === 0) {
                    util.deleteNode(nodes[i]);
                }
            }
        });

        // Force display of elements with certain CSS classes
        cssClassDisplayList.map(function (classname) {
            let nodes = dom.getElementsByClassName(classname);
            for (let i = 0; i < nodes.length; i++) {
                nodes[i].style.removeProperty('display');
            }
        });
    }

    function writeArticle(json, articleId, finished) {
        printLog('Saving article ' + articleId + '...');

        if (deflateTmpHtml) {
            zlib.deflate(JSON.stringify(json), function (error, deflatedContent) {
                fs.writeFile(getArticlePath(articleId), deflatedContent, finished);
            });
        } else {
            fs.writeFile(getArticlePath(articleId), JSON.stringify(json), finished);
        }
    }

    function saveArticle(articleId, finished) {


        //let articleUrl = parsoidUrl + encodeURIComponent(articleId) + ( parsoidUrl.indexOf('/rest') < 0 ? (parsoidUrl.indexOf('?') < 0 ? '?' : '&' ) + 'oldid=' : '/' ) + articleIds[articleId];

        let articleUrl = "https://en.wikipedia.org/api/rest_v1/page/mobile-sections/" + encodeURIComponent(articleId);


        console.log(">>>>>>> Saving \"" + articleUrl + "\"");


        printLog('Getting article from ' + articleUrl);
        setTimeout(skipHtmlCache || articleId == mainPageId ? downloadContent : downloadContentAndCache,
            downloadFileQueue.length() + optimizationQueue.length(),
            articleUrl,
            function (content, responseHeaders, articleId) {

                let json = JSON.parse(content.toString());

                if (!json['lead']) {
                    printErr('Error retrieving article: ' + articleId);
                }

                if (json) {
                    let articlePath = getArticlePath(articleId);

                    printLog('Treating and saving article ' + articleId + ' at ' + articlePath + '...');

                    transformSections(json);

                    writeArticle(json, articleId, function (error, result) {
                        if (error) {
                            printErr('Error preparing and saving file ' + error);
                            process.exit(1);
                        } else {
                            printLog('Dumped successfully article ' + articleId);
                            finished();
                        }
                    });

                } else {
                    printErr('Error retrieving article: ' + articleId);

                    delete articleIds[articleId];
                    finished();
                }
            }, articleId);
    }

    printLog('Saving articles...');
    async.eachLimit(Object.keys(articleIds),
        speed,
        saveArticle,
        function (error) {
            if (error) {
                printErr('Unable to retrieve an article correctly: ' + error);
                process.exit(1);
            } else {
                printLog('All articles were retrieved and saved.');
                finished();
            }
        });
}

function isMirrored( id ) {
    if (!articleList && id && id.indexOf(':') >= 0) {
        let namespace = namespaces[id.substring(0, id.indexOf(':')).replace(/ /g, '_')];
        if (namespace != undefined) {
            return namespace.isContent
        }
    }
    return ( id in articleIds );
}

function isSubPage( id ) {
    if (id && id.indexOf('/') >= 0) {
        let namespace = id.indexOf(':') >= 0 ? id.substring(0, id.indexOf(':')).replace(/ /g, '_') : "";
        namespace = namespaces[namespace];
        if (namespace != undefined) {
            return namespace.allowedSubpages;
        }
    }
    return false;
}

/* Get ids */
let redirectQueue = async.queue( function( articleId, finished ) {
    if (articleId) {
        printLog('Getting redirects for article ' + articleId + '...');
        let url = apiUrl + 'action=query&list=backlinks&blfilterredir=redirects&bllimit=max&format=json&bltitle=' + encodeURIComponent(articleId) + '&rawcontinue=';
        downloadContent(url, function (content) {
            let body = content.toString();
            try {
                if (!JSON.parse(body)['error']) {
                    let redirects = {};
                    let redirectsCount = 0;
                    JSON.parse(body)['query']['backlinks'].map(function (entry) {
                        redirects[entry['title'].replace(/ /g, '_')] = articleId;
                        redirectsCount++;
                    });
                    printLog(redirectsCount + ' redirect(s) found for ' + articleId);
                    if (redirectsCount) {
                        redisClient.hmset(redisRedirectsDatabase, redirects, function (error) {
                            if (error) {
                                printErr('Unable to set redirects: ' + error);
                                process.exit(1);
                            } else {
                                finished();
                            }
                        });
                    } else {
                        finished();
                    }
                } else {
                    finished(JSON.parse(body)['error']);
                }
            } catch (error) {
                finished(error);
            }
        });
    } else {
        finished();
    }
}, speed * 3 );

function getArticleIds( finished ) {

    function drainRedirectQueue(finished) {
        redirectQueue.drain = function (error) {
            if (error) {
                printErr('Unable to retrieve redirects for an article: ' + error);
                process.exit(1);
            } else {
                printLog('All redirect ids retrieve successfully.');
                finished();
            }
        };
        redirectQueue.push('');
    }

    /* Parse article list given by API */
    function parseJson(body) {
        let next = '';
        let json = JSON.parse(body);
        let entries = json['query'] && json['query']['pages'];

        if (entries) {
            let redirectQueueValues = [];
            let details = {};
            Object.keys(entries).map(function (key) {
                let entry = entries[key];
                entry['title'] = entry['title'].replace(/ /g, '_');

                if ('missing' in entry) {
                    printErr('Article ' + entry['title'] + ' is not available on this wiki.');
                    delete articleIds[entry['title']];
                } else {
                    redirectQueueValues.push(entry['title']);

                    if (entry['revisions']) {

                        /* Get last revision id */
                        articleIds[entry['title']] = entry['revisions'][0]['revid'];

                        /* Get last revision id timestamp */
                        let articleDetails = {'t': parseInt(new Date(entry['revisions'][0]['timestamp']).getTime() / 1000)};

                        /* Get article geo coordinates */
                        if (entry['coordinates']) {
                            articleDetails['g'] = entry['coordinates'][0]['lat'] + ';' + entry['coordinates'][0]['lon'];
                        }

                        /* Save as JSON string */
                        details[entry['title']] = JSON.stringify(articleDetails);
                    } else if (entry['pageid']) {
                        printLog('Unable to get revisions for ' + entry['title'] + ', but entry exists in the database. Article was probably deleted meanwhile.');
                        delete articleIds[entry['title']];
                    } else {
                        printErr('Unable to get revisions for ' + entry['title']);
                        printErr('JSON was ' + body);
                        process.exit(1);
                    }
                }
            });

            if (redirectQueueValues.length)
                redirectQueue.push(redirectQueueValues);
            if (Object.keys(details).length) {
                redisClient.hmset(redisArticleDetailsDatabase, details, function (error) {
                    if (error) {
                        printErr('Unable to save article detail information to redis: ' + error);
                        process.exit(1);
                    }
                });
            }

            /* Get continue parameters from 'query-continue',
             * unfortunately old MW version does not use the same way
             * than recent */
            let continueHash = json['query-continue'] && json['query-continue']['allpages'];
            if (continueHash) {
                for (let key in continueHash) {
                    next += '&' + key + '=' + encodeURIComponent(continueHash[key]);
                }
            }
        }

        return next;
    }

    /* Get ids from file */
    function getArticleIdsForLine(line, finished) {
        if (line) {
            let title = line.replace(/ /g, '_').replace('\r', '');
            let url = apiUrl + 'action=query&redirects&format=json&prop=revisions|coordinates&titles=' + encodeURIComponent(title);
            setTimeout(downloadContent, redirectQueue.length() > 30000 ? redirectQueue.length() - 30000 : 0, url, function (content) {
                let body = content.toString();
                if (body && body.length > 1) {
                    parseJson(body);
                }
                setTimeout(finished, redirectQueue.length());
            });
        } else {
            finished();
        }
    }

    function getArticleIdsForFile(finished) {
        try {
            let lines = fs.readFileSync(articleList).toString().split('\n');

            async.eachLimit(lines, speed, getArticleIdsForLine, function (error) {
                if (error) {
                    printErr('Unable to get all article ids for a file: ' + error);
                    process.exit(1);
                } else {
                    printLog('List of article ids to mirror completed');
                    drainRedirectQueue(finished);
                }
            });
        } catch (error) {
            printErr('Unable to open article list file: ' + error);
            process.exit(1);
        }
    }

    /* Get ids from Mediawiki API */
    function getArticleIdsForNamespace(namespace, finished) {
        let next = '';

        async.doWhilst(
            function (finished) {
                printLog('Getting article ids for namespace "' + namespace + '" ' + ( next != '' ? ' (from ' + ( namespace ? namespace + ':' : '') + next.split('=')[1] + ')' : '' ) + '...');
                let url = apiUrl + 'action=query&generator=allpages&gapfilterredir=nonredirects&gaplimit=max&colimit=max&prop=revisions|coordinates&gapnamespace=' + namespaces[namespace].number + '&format=json' + '&rawcontinue=' + next;
                setTimeout(downloadContent, redirectQueue.length() > 30000 ? redirectQueue.length() - 30000 : 0, url, function (content) {
                    let body = content.toString();
                    if (body && body.length > 1) {
                        next = parseJson(body);
                        finished();
                    } else {
                        next = '';
                        finished('Error retrieving ' + url);
                    }
                });
            },
            function () {
                return next
            },
            function (error) {
                if (error) {
                    printErr('Unable to download article ids: ' + error);
                    process.exit(1);
                } else {
                    printLog('List of article ids to mirror completed for namespace "' + namespace + '"');
                    finished();
                }
            }
        );
    }

    function getArticleIdsForNamespaces() {
        async.eachLimit(namespacesToMirror, namespacesToMirror.length, getArticleIdsForNamespace, function (error) {
            if (error) {
                printErr('Unable to get all article ids for in a namespace: ' + error);
                process.exit(1);
            } else {
                printLog('All articles ids (but without redirect ids) for all namespaces were successfully retrieved.');
                drainRedirectQueue(finished);
            }
        });
    }

    /* Get list of article ids */
    async.series(
        [
            function (finished) {
                getArticleIdsForLine(mainPageId, finished)
            },
            function (finished) {
                if (articleList) {
                    getArticleIdsForFile(finished);
                } else {
                    getArticleIdsForNamespaces(finished)
                }
            },
            function (finished) {
                if (articleList) {
                    finished()
                } else {
                    if (!isMirrored(mainPageId)) {
                        getArticleIdsForLine(mainPageId, finished)
                    } else {
                        finished();
                    }
                }
            }
        ],
        function (error) {
            if (error) {
                printErr('Unable retrive article ids: ' + error);
                process.exit(1);
            } else {
                finished();
            }
        }
    );
}

/* Create directories for static files */
function createSubDirectories( finished ) {
    printLog('Creating sub directories at \"' + htmlRootPath + '\"...');
    async.series(
        [
            function (finished) {
                exec('rm -rf \"' + htmlRootPath + '\"', finished)
            },
            function (finished) {
                fs.mkdir(htmlRootPath, undefined, finished)
            },
            function (finished) {
                fs.mkdir(htmlRootPath + styleDirectory, undefined, finished)
            },
            function (finished) {
                fs.mkdir(htmlRootPath + mediaDirectory, undefined, finished)
            },
            function (finished) {
                fs.mkdir(htmlRootPath + javascriptDirectory, undefined, finished)
            }
        ],
        function (error) {
            if (error) {
                printErr('Unable to create mandatory directories : ' + error);
                process.exit(1);
            } else {
                finished();
            }
        });
}

/* Multiple developer friendly functions */
function getFullUrl( url, baseUrl ) {
    let urlObject = urlParser.parse(url, false, true);

    if (!urlObject.protocol) {

        let baseUrlObject = baseUrl ? urlParser.parse(baseUrl, false, true) : {};
        urlObject.protocol = urlObject.protocol || baseUrlObject.protocol || 'http:';
        urlObject.host = urlObject.host || baseUrlObject.host || webUrlHost;

        /* Relative path */
        if (urlObject.pathname && urlObject.pathname.indexOf('/') != 0 && baseUrlObject.pathname) {
            urlObject.pathname = pathParser.dirname(baseUrlObject.pathname) + '/' + urlObject.pathname;
        }

        url = urlParser.format(urlObject);
    }

    return url;
}

function downloadContentAndCache( url, callback, var1, var2, var3 ) {
    let cachePath = cacheDirectory + crypto.createHash('sha1').update(url).digest('hex').substr(0, 20);
    let cacheHeadersPath = cachePath + '.h';

    async.series(
        [
            function (finished) {
                fs.readFile(cachePath, function (error, data) {
                    finished(error, error ? undefined : data.toString());
                })
            },
            function (finished) {
                fs.readFile(cacheHeadersPath, function (error, data) {
                    try {
                        finished(error, error ? undefined : JSON.parse(data.toString()));
                    } catch (error) {
                        finished('Error in downloadContentAndCache() JSON parsing of ' + cacheHeadersPath + ', error is: ' + error);
                    }
                });
            }
        ],
        function (error, results) {
            if (error) {
                downloadContent(url, function (content, responseHeaders) {
                    printLog('Caching ' + url + ' at ' + cachePath + '...');
                    fs.writeFile(cacheHeadersPath, JSON.stringify(responseHeaders), function () {
                        fs.writeFile(cachePath, content, function () {
                            callback(content, responseHeaders, var1, var2, var3);
                        });
                    });
                });
            } else {
                printLog('Cache hit for ' + url + ' (' + cachePath + ')');
                touch(cachePath, cacheHeadersPath);
                callback(results[0], results[1], var1, var2, var3);
            }
        }
    );
}

function getRequestOptionsFromUrl( url, compression ) {
    let urlObj = urlParser.parse(url);
    let port = urlObj.port ? urlObj.port : ( urlObj.protocol && urlObj.protocol.substring(0, 5) == 'https' ? 443 : 80 );
    let headers = {
        'accept': 'text/html; charset=utf-8; profile="mediawiki.org/specs/html/1.2.0"',
        'accept-encoding': ( compression ? 'gzip, deflate' : '' ),
        'cache-control': 'public, max-stale=2678400',
        'user-agent': userAgentString,
        'cookie': loginCookie
    };

    return {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: port,
        headers: headers,
        path: urlObj.path,
        method: url.indexOf('action=login') > -1 ? 'POST' : 'GET'
    };
}

function downloadContent( url, callback, var1, var2, var3 ) {
    let retryCount = 0;
    let responseHeaders = {};

    printLog('Downloading ' + decodeURI(url) + '...');
    async.retry(
        3,
        function (finished) {
            let request;
            let calledFinished = false;

            function callFinished(timeout, message, data) {
                if (!calledFinished) {
                    calledFinished = true;
                    if (message) {
                        printErr(message);
                        request.abort();
                    }
                    request = undefined;
                    setTimeout(finished, timeout, message, data);
                }
            }

            retryCount++;

            /* Analyse url */
            let options = getRequestOptionsFromUrl(url, true);

            /* Protocol detection */
            let protocol;
            if (options.protocol == 'http:') {
                protocol = http;
            } else if (options.protocol == 'https:') {
                protocol = https;
            } else {
                printErr('Unable to determine the protocol of the following url (' + options.protocol + '), switched back to ' + ( webUrlPort == 443 ? 'https' : 'http' ) + ': ' + url);
                if (webUrlPort == 443) {
                    protocol = https;
                    url = url.replace(options.protocol, 'https:');
                } else {
                    protocol = http;
                    url = url.replace(options.protocol, 'http:');
                }
                printErr('New url is: ' + url);
            }

            /* Downloading */
            options = getRequestOptionsFromUrl(url, true);
            request = ( protocol ).get(options, function (response) {
                if (response.statusCode == 200) {
                    let chunks = [];
                    response.on('data', function (chunk) {
                        chunks.push(chunk);
                    });
                    response.on('end', function () {
                        responseHeaders = response.headers;
                        let encoding = responseHeaders['content-encoding'];
                        if (encoding == 'gzip') {
                            zlib.gunzip(Buffer.concat(chunks), function (error, decoded) {
                                callFinished(0, error, decoded && decoded.toString());
                            });
                        } else if (encoding == 'deflate') {
                            zlib.inflate(Buffer.concat(chunks), function (error, decoded) {
                                callFinished(0, error, decoded && decoded.toString());
                            })
                        } else {
                            callFinished(0, null, Buffer.concat(chunks));
                        }
                    });
                    response.on('error', function (error) {
                        response.socket.emit('agentRemove');
                        response.socket.destroy();
                        callFinished(0, 'Unable to download content [' + retryCount + '] ' + decodeURI(url) + ' (response error: ' + response.statusCode + ').');
                    });
                } else {
                    response.socket.emit('agentRemove');
                    response.socket.destroy();
                    callFinished(0, 'Unable to download content [' + retryCount + '] ' + decodeURI(url) + ' (statusCode=' + response.statusCode + ').');
                }
            });
            request.on('error', function (error) {
                callFinished(10000 * retryCount, 'Unable to download content [' + retryCount + '] ' + decodeURI(url) + ' (request error: ' + error + ' ).');
            });
            request.on('socket', function (socket) {
                if (!socket.custom) {
                    socket.custom = true;
                    socket.on('error', function (error) {
                        printErr('Socket timeout');
                        socket.emit('agentRemove');
                        socket.destroy();
                        if (request) {
                            request.emit('error', 'Socket timeout');
                        }
                    });
                    socket.on('timeout', function (error) {
                        printErr('Socket error');
                        socket.emit('agentRemove');
                        socket.end();
                        if (request) {
                            request.emit('error', 'Socket error');
                        }
                    });
                }
            });
            request.setTimeout(requestTimeout * 1000 * retryCount);
            request.end();
        },
        function (error, data) {
            if (error) {
                printErr('Absolutly unable to retrieve async. URL: ' + error);

                /* Unfortunately we can not do that because there are
                 * article which simply will not be parsed correctly by
                 * Parsoid. For example this one
                 * http://parsoid-lb.eqiad.wikimedia.org/dewikivoyage/Via_Jutlandica/Gpx
                 * and this stops the whole dumping process */
                // process.exit( 1 );
            }
            callback(data || new Buffer(0), responseHeaders, var1, var2, var3);
        });
}

function downloadFileAndCache( url, callback ) {
    let parts = mediaRegex.exec(decodeURI(url));
    let filenameBase = ( parts[2].length > parts[5].length ? parts[2] : parts[5] + (parts[6] || ".svg") + ( parts[7] || '' ) );
    let width = parseInt(parts[4].replace(/px\-/g, '')) || INFINITY_WIDTH;

    /* Check if we have already met this image during this dumping process */
    redisClient.hget(redisMediaIdsDatabase, filenameBase, function (error, r_width) {

        /* If no redis entry */
        if (error || !r_width || r_width < width) {

            /* Set the redis entry if necessary */
            redisClient.hset(redisMediaIdsDatabase, filenameBase, width, function (error) {
                if (error) {
                    printErr('Unable to set redis entry for file to download ' + filenameBase + ': ' + error);
                    process.exit(1);
                } else {
                    let mediaPath = getMediaPath(url);
                    let cachePath = cacheDirectory + 'm/' + crypto.createHash('sha1').update(filenameBase).digest('hex').substr(0, 20) +
                        ( pathParser.extname(urlParser.parse(url, false, true).pathname || '') || '' );
                    let cacheHeadersPath = cachePath + '.h';
                    let toDownload = false;

                    /* Check if the file exists in the cache */
                    if (fs.existsSync(cacheHeadersPath) && fs.existsSync(cachePath)) {
                        let responseHeaders;
                        try {
                            responseHeaders = JSON.parse(fs.readFileSync(cacheHeadersPath).toString());
                        } catch (error) {
                            printErr('Error in downloadFileAndCache() JSON parsing of ' + cacheHeadersPath + ', error is: ' + error);
                            responseHeaders = undefined;
                        }

                        /* If the cache file width higher than needed, use it. Otherwise download it and erase the cache */
                        if (!responseHeaders || responseHeaders.width < width) {
                            toDownload = true;
                        } else {
                            fs.symlink(cachePath, mediaPath, 'file', function (error) {
                                if (error) {
                                    if (error.code != 'EEXIST') {
                                        printErr('Unable to create symlink to ' + mediaPath + ' at ' + cachePath + ': ' + error);
                                        process.exit(1);
                                    } else if (!skipCacheCleaning) {
                                        touch(cachePath);
                                    }
                                }

                                if (!skipCacheCleaning) {
                                    touch(cacheHeadersPath);
                                }
                            });
                            if (responseHeaders.width == width) {
                                redisClient.hdel(redisCachedMediaToCheckDatabase, filenameBase);
                            } else {
                                redisClient.hset(redisCachedMediaToCheckDatabase, filenameBase, width, function (error) {
                                    if (error) {
                                        printErr('Unable to set redis cache media to check ' + filenameBase + ': ' + error);
                                        process.exit(1);
                                    }
                                });
                            }
                            callback();
                        }
                    } else {
                        toDownload = true;
                    }

                    /* Download the file if necessary */
                    if (toDownload) {
                        downloadFile(url, cachePath, true, function (error) {
                            if (error) {
                                callback();
                            } else {
                                printLog('Caching ' + filenameBase + ' at ' + cachePath + '...');
                                fs.symlink(cachePath, mediaPath, 'file', function (error) {
                                    if (error && error.code != 'EEXIST') {
                                        printErr('Unable to create symlink to ' + mediaPath + ' at ' + cachePath + ': ' + error);
                                        process.exit(1);
                                    }
                                    fs.writeFile(cacheHeadersPath, JSON.stringify({width: width}), function (error) {
                                        if (error) {
                                            printErr('Unable to write cache header at ' + cacheHeadersPath + ': ' + error);
                                            process.exit(1);
                                        }
                                        callback();
                                    });
                                });
                            }
                        });
                    } else {
                        printLog('Cache hit for ' + url);
                    }
                }
            });
        }


        else {
            // We already have this image with a resolution equal or higher to what we need */
            callback();
        }
    });
}

function downloadFile( url, path, force, callback ) {
    fs.stat(path, function (error) {
        if (error && !force) {
            if (error.code == 'ENOENT') {
                printLog(path + ' already downloaded, download will be skipped.');
                callback();
            } else {
                printLog('Impossible to stat() ' + path + ': ' + error);
                process.exit(1);
            }
        } else {
            printLog('Downloading ' + decodeURI(url) + ' at ' + path + '...');
            downloadContent(url, function (content, responseHeaders) {
                fs.writeFile(path, content, function (error) {
                    if (error) {
                        printErr('Unable to write ' + path + ' (' + url + ')');
                        process.exit(1);
                    } else {
                        optimizationQueue.push({path: path, size: content.length});
                    }
                    callback(error, responseHeaders);
                });
            });
        }
    });
}

/* Internal path/url functions */
function getMediaUrl( url ) {
    return getMediaBase(url, true);
}

function getMediaPath( url, escape ) {
    let mediaBase = getMediaBase(url, escape);
    return mediaBase ? htmlRootPath + mediaBase : undefined;
}

function getMediaBase( url, escape ) {
    let root;

    let parts = mediaRegex.exec(decodeURI(url));
    if (parts) {
        root = parts[2].length > parts[5].length ? parts[2] : parts[5] + (parts[6] || ".svg") + ( parts[7] || '' );
    }

    if (!root) {
        printErr('Unable to parse media url \"' + url + '\"');
        return;
    }

    function e(string) {
        return ( string === undefined ? undefined :
            escape ? encodeURIComponent(string) : string );
    }

    let filenameFirstVariant = parts[2];
    let filenameSecondVariant = parts[5] + (parts[6] || ".svg") + ( parts[7] || '' );
    let filename = util.myDecodeURIComponent(filenameFirstVariant.length > filenameSecondVariant.length ?
        filenameFirstVariant : filenameSecondVariant);

    /* Need to shorten the file due to filesystem limitations */
    if (unicodeCutter.getBinarySize(filename) > 249) {
        let ext = pathParser.extname(filename).split('.')[1] || '';
        let basename = filename.substring(0, filename.length - ext.length - 1) || '';
        filename = unicodeCutter.truncateToBinarySize(basename, 239 - ext.length) + crypto.createHash('md5').update(basename).digest('hex').substring(0, 2) + '.' + ext;
    }

    return mediaDirectory + '/' + e(filename);
}

function getArticleUrl( articleId ) {
    return getArticleBase(articleId, true);
}

function getArticlePath( articleId, escape ) {
    return htmlRootPath + getArticleBase(articleId, escape);
}

function getArticleBase( articleId, escape ) {
    let filename = articleId.replace(/\//g, '_');
    let dirBase = filename.replace(/\./g, '_');

    /* Filesystem is not able to handle with filename > 255 bytes */
    while (Buffer.byteLength(filename, 'utf8') > 250) {
        filename = filename.substr(0, filename.length - 1);
    }

    function e(string) {
        return ( string === undefined ? undefined :
            escape ? encodeURIComponent(string) : string );
    }

    return e(filename) + '.html';
}

function getSubTitle( finished ) {
    printLog('Getting sub-title...');
    downloadContent(webUrl, function (content) {
        let html = content.toString();
        let doc = domino.createDocument(html);
        let subTitleNode = doc.getElementById('siteSub');
        subTitle = subTitleNode ? subTitleNode.innerHTML : '';
        finished();
    });
}

function getSiteInfo( finished ) {
    printLog('Getting web site name...');
    let url = apiUrl + 'action=query&meta=siteinfo&format=json&siprop=general|namespaces|statistics|variables|category|wikidesc';
    downloadContent(url, function (content) {
        let body = content.toString();
        let entries = JSON.parse(body)['query']['general'];

        /* Welcome page */
        if (!mainPageId && !articleList) {
            mainPageId = entries['mainpage'].replace(/ /g, '_');
        }

        /* Site name */
        if (!name) {
            name = entries['sitename'];
        }

        /* Language */
        langIso2 = entries['lang'];
        countryLanguage.getLanguage(langIso2, function (error, language) {
            if (error || !language.iso639_3) {
                langIso3 = langIso2;
            } else {
                langIso3 = language.iso639_3;
            }
            finished();
        });
    });
}

function saveFavicon( finished ) {
    printLog('Saving favicon.png...');
    let faviconPath = htmlRootPath + 'favicon.png';

    function resizeFavicon(finished) {
        let cmd = 'convert -thumbnail 48 "' + faviconPath + '" "' + faviconPath + '.tmp" ; mv  "' + faviconPath + '.tmp" "' + faviconPath + '" ';
        exec(cmd, function () {
            fs.stat(faviconPath, function (error, stats) {
                optimizationQueue.push({path: faviconPath, size: stats.size}, function () {
                    finished(error);
                });
            });
        }).on('error', function (error) {
            printErr(error)
        });
    }

    if (customZimFavicon) {
        let content = fs.readFileSync(customZimFavicon);
        fs.writeFileSync(faviconPath, content);
        resizeFavicon(finished);
    } else {
        downloadContent(apiUrl + 'action=query&meta=siteinfo&format=json', function (content) {
            let body = content.toString();
            let entries = JSON.parse(body)['query']['general'];
            let logoUrl = entries['logo'];
            logoUrl = urlParser.parse(logoUrl).protocol ? logoUrl : 'http:' + logoUrl;
            downloadFile(logoUrl, faviconPath, true, function () {
                resizeFavicon(finished);
            });
        });
    }
}

function getMainPage( finished ) {

    function writeMainPage(html, finished) {
        let mainPagePath = htmlRootPath + 'index.htm';
        if (deflateTmpHtml) {
            zlib.deflate(html, function (error, deflatedHtml) {
                fs.writeFile(mainPagePath, deflatedHtml, finished);
            });
        } else {
            fs.writeFile(mainPagePath, html, finished);
        }
    }

    function createMainPage(finished) {
        printLog('Creating main page...');
        let doc = domino.createDocument(htmlTemplateCode);
        doc.getElementById('titleHeading').innerHTML = 'Summary';
        doc.getElementsByTagName('title')[0].innerHTML = 'Summary';

        let html = '<ul>\n';
        Object.keys(articleIds).sort().map(function (articleId) {
            html = html + '<li><a href="' + getArticleBase(articleId, true) + '"\>' + articleId.replace(/_/g, ' ') + '<a></li>\n';
        });
        html = html + '</ul>\n';
        doc.getElementById('mw-content-text').innerHTML = html;

        /* Write the static html file */
        writeMainPage(doc.documentElement.outerHTML, finished);
    }

    function createMainPageRedirect(finished) {
        printLog('Create main page redirection...');
        let html = redirectTemplateCode.replace("{{ title }}", mainPageId.replace(/_/g, ' ')).replace("{{ target }}", getArticleBase(mainPageId, true));
        writeMainPage(html, finished);
    }

    if (mainPageId) {
        createMainPageRedirect(finished);
    } else {
        createMainPage(finished);
    }
}

function getNamespaces( finished ) {
    let url = apiUrl + 'action=query&meta=siteinfo&siprop=namespaces|namespacealiases&format=json';
    downloadContent(url, function (content) {
        let body = content.toString();
        let types = ['namespaces', 'namespacealiases'];
        types.map(function (type) {
            let entries = JSON.parse(body)['query'][type];
            Object.keys(entries).map(function (key) {
                let entry = entries[key];
                let name = entry['*'].replace(/ /g, '_');
                let number = entry['id'];
                let allowedSubpages = ( 'subpages' in entry );
                let isContent = entry['content'] != undefined;
                let canonical = entry['canonical'] ? entry['canonical'].replace(/ /g, '_') : '';
                let details = {'number': number, 'allowedSubpages': allowedSubpages, 'isContent': isContent};

                /* Namespaces in local language */
                namespaces[util.lcFirst(name)] = details;
                namespaces[util.ucFirst(name)] = details;

                /* Namespaces in English (if available) */
                if (canonical) {
                    namespaces[util.lcFirst(canonical)] = details;
                    namespaces[util.ucFirst(canonical)] = details;
                }

                /* Is content to mirror */
                if (isContent) {
                    namespacesToMirror.push(name);
                }
            });
        });

        finished();
    });
}

function getTextDirection( finished ) {
    printLog('Getting text direction...');

    downloadContent(webUrl, function (content) {
        let body = content.toString();
        let doc = domino.createDocument(body);
        let contentNode = doc.getElementById('mw-content-text');
        let languageDirectionRegex = /\"pageLanguageDir\"\:\"(.*?)\"/;
        let parts = languageDirectionRegex.exec(body);
        if (parts && parts[1]) {
            ltr = ( parts[1] === 'ltr' );
        } else if (contentNode) {
            ltr = ( contentNode.getAttribute('dir') == 'ltr' );
        } else {
            printLog('Unable to get the language direction, fallback to ltr');
            ltr = true;
        }

        /* Update alignment values */
        autoAlign = ltr ? 'left' : 'right';
        revAutoAlign = ltr ? 'right' : 'left';

        printLog('Text direction is ' + ( ltr ? 'ltr' : 'rtl' ));
        finished();
    });
}

function printLog( msg ) {
    if (verbose) {
        console.info(msg);
    }
}

function printErr( msg ) {
    console.error(msg);
}

function executeTransparently( command, args, callback, nostdout, nostderr ) {
    try {
        let proc = spawn(command, args)
            .on('error', function (error) {
                printErr('Error in executeTransparently(), ' + error);
                process.exit(1);
            });

        if (!nostdout) {
            proc.stdout
                .on('data', function (data) {
                    printLog(data.toString().replace(/[\n\r]/g, ''));
                })
                .on('error', function (error) {
                    printErr('STDOUT output error: ' + error);
                });
        }

        if (!nostderr) {
            proc.stderr
                .on('data', function (data) {
                    printErr(data.toString().replace(/[\n\r]/g, ''));
                })
                .on('error', function (error) {
                    printErr('STDERR output error: ' + error);
                });
        }

        proc.on('close', function (code) {
            callback(code !== 0 ? 'Error executing ' + command : undefined);
        });
    } catch (error) {
        callback('Error executing ' + command);
    }
}

function touch( paths ) {
    let currentDate = Date.now();
    paths = paths instanceof Array ? paths : [paths];
    paths.map(function (path) {
        fs.utimes(path, currentDate, currentDate);
    });
}

process.on( 'uncaughtException', function( error ) {
    printErr(error.stack);
    process.exit(42);
});
