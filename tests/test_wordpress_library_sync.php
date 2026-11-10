<?php
/** Standalone endpoint contract tests; no WordPress installation required. */
define('ABSPATH', sys_get_temp_dir() . '/lctp-wp-test-' . bin2hex(random_bytes(5)) . '/');
class WP_Error {
    public $code;
    public $message;
    public $data;
    public function __construct($code, $message, $data = array()) {
        $this->code = $code;
        $this->message = $message;
        $this->data = $data;
    }
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
}
class WP_REST_Response {
    public $data;
    public $status;
    public $headers;
    public function __construct($data = null, $status = 200, $headers = array()) {
        $this->data = $data;
        $this->status = $status;
        $this->headers = $headers;
    }
}
class TestRequest {
    private $etag;
    public function __construct($etag = '') { $this->etag = $etag; }
    public function get_header($name) { return strtolower($name) === 'if-none-match' ? $this->etag : ''; }
}
$route = null;
function add_action($hook, $callback) { $callback(); }
function register_rest_route($namespace, $path, $definition) { $GLOBALS['route'] = array($namespace, $path, $definition); }
function home_url($path = '') { return 'https://example.org' . $path; }
function wp_json_encode($value) { return json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); }
function wp_parse_url($url) { return parse_url($url); }
function is_wp_error($value) { return $value instanceof WP_Error; }
function check($condition, $message) { if (!$condition) { throw new RuntimeException($message); } }
require dirname(__DIR__) . '/wordpress/lctp-library-sync.php';

$root = ABSPATH . 'lctp-library';
$version = '20261109T120000Z-12345678';
$base = 'https://example.org/lctp-library/releases/';
$release = $root . '/releases/' . $version;
mkdir($release, 0755, true);
file_put_contents($release . '/manifest.json', '{"schema_version":1}');
file_put_contents($release . '/project.zip', 'zip-fixture');
$valid = array(
    'schema_version' => 1,
    'version' => $version,
    'source_revision' => str_repeat('a', 40),
    'published_at' => '2026-11-09T12:00:00Z',
    'manifest_url' => $base . $version . '/manifest.json',
    'manifest_sha256' => hash_file('sha256', $release . '/manifest.json'),
    'archive_url' => $base . $version . '/project.zip',
    'archive_sha256' => hash_file('sha256', $release . '/project.zip'),
    'archive_size' => strlen('zip-fixture'),
    'file_count' => 1,
);
$write = function ($value) use ($root) { file_put_contents($root . '/latest.json', json_encode($value)); };
try {
    $write($valid);
    $loaded = lctp_library_sync_read_release($root, $base);
    check(!is_wp_error($loaded), 'Expected a valid published snapshot to be available, got 503.');
    check($loaded === $valid, 'Metadata must preserve the public protocol fields.');
    $response = lctp_library_sync_response(new TestRequest());
    check($response instanceof WP_REST_Response && $response->status === 200, 'GET returns HTTP 200.');
    check(strpos($response->headers['Cache-Control'], 'no-cache') !== false, 'Latest metadata requires revalidation.');
    $etag = $response->headers['ETag'];
    check($response->data === $valid, 'GET returns the current metadata.');
    foreach (array($etag, 'W/' . $etag, '"other", ' . $etag, '*') as $condition) {
        $cached = lctp_library_sync_response(new TestRequest($condition));
        check($cached->status === 304 && $cached->data === null, 'Matching ETag returns an empty 304.');
        check($cached->headers['ETag'] === $etag, '304 retains the current ETag.');
    }
    check(lctp_library_sync_response(new TestRequest('"old"'))->status === 200, 'Stale ETag returns fresh metadata.');
    check($route[0] === 'lctp/v1' && $route[1] === '/project', 'Only the intended route is registered.');
    check($route[2]['methods'] === 'GET' && $route[2]['permission_callback'] === '__return_true', 'Public endpoint only supports reads.');
    $invalid = array(
        array('schema_version', '1'), array('schema_version', 2), array('version', '../private'),
        array('version', 'bad/version'), array('version', str_repeat('v', 81)), array('source_revision', 'not-a-revision'),
        array('published_at', 'yesterday'), array('published_at', '2026-02-30T12:00:00Z'),
        array('manifest_sha256', 'bad'), array('archive_sha256', 'bad'),
        array('archive_size', -1), array('archive_size', true), array('archive_size', 268435457), array('file_count', '1'), array('file_count', 25001),
        array('manifest_url', 'https://evil.example/manifest.json'),
        array('manifest_url', $base . $version . '/../secret'),
        array('archive_url', 'http://example.org/lctp-library/releases/' . $version . '/project.zip'),
        array('archive_url', $base . $version . '/project.zip?redirect=evil'),
    );
    foreach ($invalid as $change) {
        $value = $valid;
        $value[$change[0]] = $change[1];
        $write($value);
        $error = lctp_library_sync_read_release($root, $base);
        check(is_wp_error($error) && $error->data['status'] === 503, 'Invalid ' . $change[0] . ' must fail closed.');
        check(strpos($error->message, $root) === false, 'Errors must not disclose local paths.');
    }
    $write($valid + array('internal_path' => '/private/data'));
    check(lctp_library_sync_read_release($root, $base) === $valid, 'Unknown metadata cannot leak to clients.');
    file_put_contents($root . '/latest.json', '{broken');
    check(is_wp_error(lctp_library_sync_read_release($root, $base)), 'Malformed JSON is unavailable.');
    $write($valid);
    unlink($release . '/manifest.json');
    check(is_wp_error(lctp_library_sync_read_release($root, $base)), 'Incomplete publication is unavailable.');
    unlink($root . '/latest.json');
    check(is_wp_error(lctp_library_sync_read_release($root, $base)), 'Missing release is unavailable.');
    $error_response = lctp_library_sync_response(new TestRequest());
    check($error_response->status === 503 && $error_response->headers['Cache-Control'] === 'no-store', 'Unavailable releases must not be cached.');
    check($error_response->data['code'] === 'lctp_library_unavailable', 'Unavailable releases return a stable error code.');
    echo "WordPress library endpoint contract tests passed.\n";
} finally {
    foreach (array($release . '/manifest.json', $release . '/project.zip', $root . '/latest.json') as $path) {
        if (file_exists($path)) { unlink($path); }
    }
    rmdir($release);
    rmdir($root . '/releases');
    rmdir($root);
    rmdir(ABSPATH);
}
