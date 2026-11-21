<?php
/** Standalone behavior tests for the WordPress library request statistics. */
define('ABSPATH', sys_get_temp_dir() . '/lctp-stats-test-' . bin2hex(random_bytes(5)) . '/');
define('ARRAY_A', 'ARRAY_A');
require __DIR__ . '/wordpress_library_stats_sql_fixture.php';
mkdir(ABSPATH . 'wp-admin/includes', 0755, true);
file_put_contents(ABSPATH . 'wp-admin/includes/upgrade.php', "<?php\n");

$GLOBALS['stats_options'] = array();
$GLOBALS['stats_hooks'] = array();
$GLOBALS['stats_routes'] = array();
$GLOBALS['stats_admin'] = false;
$GLOBALS['stats_ddl'] = array();
$GLOBALS['stats_now'] = new DateTimeImmutable('2026-11-10 00:30:00', new DateTimeZone('Asia/Shanghai'));

function check_stats($condition, $message) {
    if (!$condition) {
        throw new RuntimeException($message);
    }
}
function add_action($hook, $callback, $priority = 10, $arguments = 1) {
    $GLOBALS['stats_hooks'][$hook][] = array($callback, $priority, $arguments);
}
function add_filter($hook, $callback, $priority = 10, $arguments = 1) {
    add_action($hook, $callback, $priority, $arguments);
}
function register_rest_route($namespace, $path, $definition) {
    $GLOBALS['stats_routes'][$namespace . $path] = $definition;
}
function get_option($key, $default = false) {
    return $GLOBALS['stats_options'][$key] ?? $default;
}
function add_option($key, $value, $deprecated = '', $autoload = null) {
    if (array_key_exists($key, $GLOBALS['stats_options'])) { return false; }
    $GLOBALS['stats_options'][$key] = $value;
    return true;
}
function update_option($key, $value, $autoload = null) {
    $GLOBALS['stats_options'][$key] = $value;
    return true;
}
function current_user_can($capability) {
    check_stats($capability === 'manage_options', 'Statistics must require the administrator capability.');
    return $GLOBALS['stats_admin'];
}
function current_datetime() { return $GLOBALS['stats_now']; }
function wp_timezone() { return $GLOBALS['stats_now']->getTimezone(); }
function wp_timezone_string() { return 'Asia/Shanghai'; }
function wp_date($format, $timestamp = null, $timezone = null) {
    $date = $timestamp === null ? current_datetime() : (new DateTimeImmutable('@' . $timestamp));
    return $date->setTimezone($timezone ?: wp_timezone())->format($format);
}
function home_url($path = '') { return 'https://example.org' . $path; }
// Plain permalinks expose REST routes through a query string.
function rest_url($path = '') { return home_url('/index.php?rest_route=/' . ltrim($path, '/')); }
function esc_html($value) { return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8'); }
function esc_attr($value) { return esc_html($value); }
function esc_url($value) { return esc_html($value); }
function number_format_i18n($value, $decimals = 0) { return number_format($value, $decimals); }
function wp_die($message = '', ...$arguments) { throw new RuntimeException('denied:' . $message); }
function dbDelta($sql) {
    $GLOBALS['stats_ddl'][] = $sql;
    if (!$GLOBALS['wpdb']->fail_install) { $GLOBALS['wpdb']->table_exists = true; }
    return array();
}
function is_wp_error($value) { return $value instanceof WP_Error; }
class WP_Error {
    public $code;
    public $message;
    public $data;
    public function __construct($code, $message, $data = null) {
        $this->code = $code; $this->message = $message; $this->data = $data;
    }
    public function get_error_code() { return $this->code; }
    public function get_error_message() { return $this->message; }
}
class WP_REST_Response {
    private $data;
    private $status;
    private $headers;
    public function __construct($data = null, $status = 200, $headers = array()) {
        $this->data = $data; $this->status = $status; $this->headers = $headers;
    }
    public function get_data() { return $this->data; }
    public function get_status() { return $this->status; }
    public function get_headers() { return $this->headers; }
}
class StatsRequest {
    private $route;
    private $method;
    public function __construct($route, $method = 'GET') { $this->route = $route; $this->method = $method; }
    public function get_route() { return $this->route; }
    public function get_method() { return $this->method; }
}

/** An in-memory result fixture; SQL writes are captured rather than executed. */
class StatsDatabase {
    public $prefix = 'custom_';
    public $table_exists = false;
    public $fail_install = false;
    public $fail_write = false;
    public $throw_on_write = false;
    public $fail_read = false;
    public $prepared = array();
    public $queries = array();
    public $reads = array();
    public $last_error = '';
    public $errors_suppressed = false;
    public $rows = array();
    public function get_charset_collate() { return 'DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'; }
    public function suppress_errors($value = true) {
        $previous = $this->errors_suppressed;
        $this->errors_suppressed = $value;
        return $previous;
    }
    public function esc_like($value) { return addcslashes($value, '_%\\'); }
    public function prepare($sql, ...$arguments) {
        if (count($arguments) === 1 && is_array($arguments[0])) { $arguments = $arguments[0]; }
        $this->prepared[] = array('sql' => $sql, 'arguments' => $arguments);
        $index = 0;
        return preg_replace_callback('/%[sdf]/', function ($match) use (&$index, $arguments) {
            check_stats(array_key_exists($index, $arguments), 'Every SQL placeholder needs a value.');
            $value = $arguments[$index++];
            if ($match[0] === '%d') { return (string) ((int) $value); }
            if ($match[0] === '%f') { return (string) ((float) $value); }
            return "'" . str_replace("'", "''", (string) $value) . "'";
        }, $sql);
    }
    public function query($sql) {
        if ($this->throw_on_write) { throw new RuntimeException('fixture write exception'); }
        $this->queries[] = $sql;
        return $this->fail_write ? false : 1;
    }
    public function get_var($sql) {
        $this->reads[] = $sql;
        if (preg_match('/SHOW\s+TABLES/i', $sql)) {
            return $this->table_exists ? $this->prefix . (strpos($sql, 'hourly') !== false ? 'lctp_library_api_hourly' : 'lctp_library_api_daily') : null;
        }
        throw new RuntimeException('Unexpected scalar query: ' . $sql);
    }
    public function get_results($sql, $format = ARRAY_A) {
        $this->reads[] = $sql;
        if ($this->fail_read) {
            $this->last_error = 'fixture read failure';
            return null;
        }
        $rows = array_map(function ($row) {
            return $row + array('last_called_at' => '2026-11-09 16:29:00');
        }, $this->rows);
        return lctp_test_library_stats_query($sql, $this->prefix, $rows, array());
    }
}

$GLOBALS['wpdb'] = new StatsDatabase();
try {
    require dirname(__DIR__) . '/wordpress/lctp-library-stats.php';

    check_stats(empty($GLOBALS['stats_hooks']['rest_post_dispatch']), 'Internal embedded and batch dispatches must not count as HTTP calls.');
    $filter = $GLOBALS['stats_hooks']['rest_pre_serve_request'][0] ?? null;
    check_stats($filter && $filter[0] === 'lctp_library_stats_track' && $filter[2] === 4, 'Count the served HTTP response after WordPress has applied its envelope.');
    $server = new class {
        public $headers = array();
        public function send_header($name, $value) { $this->headers[$name] = $value; }
    };
    $_SERVER['REQUEST_METHOD'] = 'GET';
    foreach ($GLOBALS['stats_hooks']['rest_api_init'] ?? array() as $hook) { call_user_func($hook[0]); }
    $route = $GLOBALS['stats_routes']['lctp/v1/project/stats'] ?? null;
    check_stats(is_array($route) && $route['methods'] === 'GET', 'The statistics route must support reads only.');
    check_stats($route['permission_callback'] === 'lctp_library_stats_permission', 'The statistics route must have its own administrator permission check.');
    check_stats(lctp_library_stats_permission() === false, 'Anonymous visitors must not read statistics.');
    $GLOBALS['stats_admin'] = true;
    check_stats(lctp_library_stats_permission() === true, 'Administrators must be able to read statistics.');

    lctp_library_stats_install();
    check_stats(get_option('lctp_library_stats_schema') === '2', 'Both verified tables install schema version 2.');
    check_stats(count($GLOBALS['stats_ddl']) === 2, 'The first installation creates the legacy and hourly tables once.');
    $ddl = $GLOBALS['stats_ddl'][0];
    check_stats(strpos($ddl, 'custom_lctp_library_api_daily') !== false, 'Statistics must respect a custom WordPress table prefix.');
    check_stats(preg_match('/PRIMARY\s+KEY\s*\(\s*request_date\s*,\s*status_code\s*\)/i', $ddl) === 1, 'Date and HTTP status must identify one atomic counter.');
    check_stats(preg_match('/PRIMARY\s+KEY\s*\(\s*request_date\s*,\s*request_hour\s*,\s*status_code\s*\)/i', $GLOBALS['stats_ddl'][1]) === 1, 'Hourly counters must have one unique date, hour and status bucket.');
    lctp_library_stats_install();
    check_stats(count($GLOBALS['stats_ddl']) === 2, 'Installed requests must not repeatedly run table creation.');

    $GLOBALS['wpdb']->queries = array();
    $GLOBALS['wpdb']->prepared = array();
    foreach (array(200, 304, 503) as $status) {
        $response = new WP_REST_Response(array('version' => 'unchanged'), $status, array('ETag' => '"release-only"'));
        $returned = lctp_library_stats_track(false, $response, new StatsRequest('/lctp/v1/project'), $server);
        check_stats($returned === false && !$server->headers, 'WordPress must still serve the public response with its own cache headers.');
        check_stats($response->get_headers()['ETag'] === '"release-only"', 'Counting must preserve release validation headers.');
        check_stats($response->get_data() === array('version' => 'unchanged'), 'Counting must not add telemetry to the public metadata.');
    }
    check_stats(count($GLOBALS['wpdb']->queries) === 3, '200, 304 and 503 responses each count once.');
    foreach ($GLOBALS['wpdb']->queries as $sql) {
        check_stats(preg_match('/INSERT\s+INTO\s+`?custom_lctp_library_api_hourly`?/i', $sql) === 1, 'New requests must only write hourly storage so legacy history is not double counted.');
        check_stats(preg_match('/ON\s+DUPLICATE\s+KEY\s+UPDATE/i', $sql) === 1 && preg_match('/request_count\s*=\s*(?:`?request_count`?|`?custom_lctp_library_api_daily`?\.`?request_count`?)\s*\+\s*1/i', $sql) === 1, 'Counter increments must be atomic under concurrent requests.');
        check_stats(strpos($sql, "'2026-11-10'") !== false, 'Counter dates must use the WordPress timezone at the UTC date boundary.');
        check_stats(preg_match("/VALUES \('2026-11-10',0,/", $sql) === 1, 'The local midnight hour must be stored as hour zero.');
        check_stats(strpos($sql, "'2026-11-09 16:30:00'") !== false, 'Call timestamps must be stored in UTC.');
    }
    check_stats(count($GLOBALS['wpdb']->prepared) >= 3, 'Counter values must pass through prepared SQL.');
    $trailing = new WP_REST_Response(null, 304);
    lctp_library_stats_track(false, $trailing, new StatsRequest('/lctp/v1/project/'), $server);
    check_stats(count($GLOBALS['wpdb']->queries) === 4, 'A trailing route slash counts as the same endpoint.');
    lctp_library_stats_track(false, $trailing, new StatsRequest('/LCTP/v1/PROJECT'), $server);
    check_stats(count($GLOBALS['wpdb']->queries) === 5, 'Counting must match WordPress case-insensitive route dispatch.');
    foreach (array(
        array('/lctp/v1/project', 'HEAD'), array('/lctp/v1/project', 'OPTIONS'),
        array('/lctp/v1/project', 'POST'), array('/lctp/v1/project', 'get'),
        array('/lctp/v1/project/stats', 'GET'), array('/lctp/v1/project/other', 'GET'),
        array('/lctp/v1/projects', 'GET'), array('/lctp/v1/%70roject', 'GET'),
        array("/lctp/v1/project'; DROP TABLE wp_options; --", 'GET'),
    ) as $request) {
        lctp_library_stats_track(false, new WP_REST_Response(null, 200), new StatsRequest($request[0], $request[1]), $server);
    }
    $_SERVER['REQUEST_METHOD'] = 'HEAD';
    lctp_library_stats_track(false, $trailing, new StatsRequest('/lctp/v1/project', 'GET'), $server);
    $_SERVER['REQUEST_METHOD'] = 'GET';
    $server->headers = array();
    lctp_library_stats_track(false, new WP_REST_Response(null, 401), new StatsRequest('/lctp/v1/project/stats'), $server);
    check_stats($server->headers === array('Cache-Control' => 'private, no-store'), 'Permission failures also send private, uncacheable HTTP responses.');
    check_stats(count($GLOBALS['wpdb']->queries) === 5, 'Other routes, injected route text and non-GET methods must never increment counts.');
    check_stats(lctp_library_stats_record(99) === false && lctp_library_stats_record(600) === false, 'Invalid HTTP status codes must not enter counters.');
    check_stats(count($GLOBALS['wpdb']->queries) === 5, 'Rejected status codes must not write SQL.');
    $GLOBALS['wpdb']->fail_write = true;
    $response = new WP_REST_Response(null, 200);
    check_stats(lctp_library_stats_track(true, $response, new StatsRequest('/lctp/v1/project'), $server) === true, 'A failed write must preserve an already served response.');
    $GLOBALS['wpdb']->throw_on_write = true;
    check_stats(lctp_library_stats_track(false, $response, new StatsRequest('/lctp/v1/project'), $server) === false, 'A throwing database driver must not break the public endpoint.');
    $GLOBALS['wpdb']->throw_on_write = false;
    check_stats($GLOBALS['wpdb']->errors_suppressed === false, 'SQL failure handling must restore the previous error reporting state.');
    $GLOBALS['wpdb']->fail_write = false;

    $GLOBALS['wpdb']->rows = array(
        array('request_date' => '2026-10-10', 'status_code' => 200, 'request_count' => 100),
        array('request_date' => '2026-10-12', 'status_code' => 503, 'request_count' => 9),
        array('request_date' => '2026-11-03', 'status_code' => 200, 'request_count' => 4),
        array('request_date' => '2026-11-04', 'status_code' => 200, 'request_count' => 5),
        array('request_date' => '2026-11-04', 'status_code' => 304, 'request_count' => 6),
        array('request_date' => '2026-11-09', 'status_code' => 200, 'request_count' => 10),
        array('request_date' => '2026-11-09', 'status_code' => 304, 'request_count' => 20),
        array('request_date' => '2026-11-10', 'status_code' => 200, 'request_count' => 3),
        array('request_date' => '2026-11-10', 'status_code' => 304, 'request_count' => 2),
        array('request_date' => '2026-11-10', 'status_code' => 503, 'request_count' => 1),
    );
    $stats = lctp_library_stats_read();
    check_stats($stats['timezone'] === 'Asia/Shanghai', 'Statistics must disclose the date bucketing timezone.');
    check_stats($stats['endpoint'] === rest_url('lctp/v1/project'), 'Statistics must identify the counted endpoint.');
    check_stats($stats['summary'] === array('total' => 160, 'today' => 6, 'last_7_days' => 47, 'last_30_days' => 60), 'Summary totals must include the correct local calendar date boundaries.');
    $statuses = array();
    foreach ($stats['by_status'] as $row) { $statuses[(int) $row['status']] = (int) $row['count']; }
    check_stats($statuses === array(200 => 122, 304 => 28, 503 => 10), 'All-time status totals must not be limited to the display period.');
    $daily = array();
    foreach ($stats['daily'] as $row) { $daily[$row['date']] = $row; }
    check_stats(!isset($daily['2026-10-10']), 'The daily display must exclude dates older than 30 days.');
    check_stats($daily['2026-11-10'] === array('date' => '2026-11-10', 'total' => 6, 'success' => 3, 'not_modified' => 2, 'errors' => 1), 'Daily totals must distinguish fresh metadata, unchanged checks and errors.');
    check_stats(isset($stats['enabled_at']) && $stats['enabled_at'] !== '', 'Statistics must disclose when counting began.');
    check_stats(isset($stats['last_called_at']) && strpos($stats['last_called_at'], '2026-11-09') === 0, 'The latest call timestamp must remain UTC, independently of local date buckets.');
    $stats_response = lctp_library_stats_response();
    check_stats($stats_response instanceof WP_REST_Response && $stats_response->get_status() === 200, 'The authorized statistics route returns a REST response.');
    $headers = array_change_key_case($stats_response->get_headers(), CASE_LOWER);
    check_stats(isset($headers['cache-control']) && strpos($headers['cache-control'], 'no-store') !== false, 'Administrative statistics must not be publicly cached.');

    ob_start();
    lctp_library_stats_page();
    $page = ob_get_clean();
    check_stats(strpos($page, esc_html(rest_url('lctp/v1/project'))) !== false, 'The admin page must display this site\'s actual REST URL.');
    check_stats(strpos($page, '00:00') !== false && strpos($page, '23:00') !== false, 'Hourly details must remain readable without the chart.');

    $GLOBALS['stats_admin'] = false;
    $reads_before = count($GLOBALS['wpdb']->reads);
    ob_start();
    try { lctp_library_stats_page(); } catch (RuntimeException $error) {
        check_stats(strpos($error->getMessage(), 'denied:') === 0, 'Unauthorized pages may only fail through their explicit permission boundary.');
    }
    ob_end_clean();
    check_stats(count($GLOBALS['wpdb']->reads) === $reads_before, 'The admin page must deny access before reading private statistics.');

    $GLOBALS['wpdb']->rows = array();
    $empty = lctp_library_stats_read();
    check_stats($empty['summary'] === array('total' => 0, 'today' => 0, 'last_7_days' => 0, 'last_30_days' => 0), 'A new installation must report zero counts rather than inventing history.');
    check_stats($empty['by_status'] === array() && $empty['last_called_at'] === null, 'No calls means no status distribution or latest call.');
    check_stats(count($empty['daily']) === 30, 'The daily display must include zero-count dates.');
    foreach ($empty['daily'] as $day) {
        check_stats($day['total'] === 0 && $day['success'] === 0 && $day['not_modified'] === 0 && $day['errors'] === 0, 'Empty dates must have integer zero counters.');
    }
    $GLOBALS['wpdb']->fail_read = true;
    $failed = lctp_library_stats_response();
    check_stats($failed->get_status() === 503, 'A database failure must be reported as unavailable rather than zero activity.');
    $failed_headers = array_change_key_case($failed->get_headers(), CASE_LOWER);
    check_stats(strpos($failed_headers['cache-control'] ?? '', 'no-store') !== false, 'Statistics errors must also remain uncacheable.');
    check_stats($GLOBALS['wpdb']->errors_suppressed === false, 'Read failure handling must restore database error reporting.');

    // Failed installation must remain retryable rather than falsely recording success.
    $GLOBALS['stats_options'] = array();
    $GLOBALS['wpdb'] = new StatsDatabase();
    $GLOBALS['wpdb']->fail_install = true;
    lctp_library_stats_install();
    check_stats(get_option('lctp_library_stats_schema') !== '2', 'A missing table must not mark schema installation complete.');
    echo "WordPress library statistics behavior tests passed.\n";
} finally {
    unlink(ABSPATH . 'wp-admin/includes/upgrade.php');
    rmdir(ABSPATH . 'wp-admin/includes');
    rmdir(ABSPATH . 'wp-admin');
    rmdir(ABSPATH);
}
