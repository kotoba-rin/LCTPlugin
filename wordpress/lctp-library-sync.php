<?php
/**
 * Plugin Name: LCTP Library Sync
 * Description: Read-only release metadata for the Lacan Translation Helper.
 * Version: 1.0.0
 * License: MIT
 */

if (!defined('ABSPATH')) {
    exit;
}

function lctp_library_sync_unavailable() {
    return new WP_Error('lctp_library_unavailable', 'The library is temporarily unavailable.', array('status' => 503));
}

function lctp_library_sync_valid_date($value) {
    if (!is_string($value) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/D', $value)) {
        return false;
    }
    try {
        new DateTimeImmutable($value);
        $errors = DateTimeImmutable::getLastErrors();
        return $errors === false || ($errors['warning_count'] === 0 && $errors['error_count'] === 0);
    } catch (Exception $error) {
        return false;
    }
}

function lctp_library_sync_validate_metadata($value, $base_url) {
    $fields = array('schema_version', 'version', 'source_revision', 'published_at', 'manifest_url', 'manifest_sha256', 'archive_url', 'archive_sha256', 'archive_size', 'file_count');
    if (!is_array($value) || count(array_diff($fields, array_keys($value))) > 0 || $value['schema_version'] !== 1) {
        return false;
    }
    if (!is_string($value['version']) || !preg_match('/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/D', $value['version'])) {
        return false;
    }
    if (!is_string($value['source_revision']) || !preg_match('/^[a-f0-9]{40,64}$/D', $value['source_revision']) || !lctp_library_sync_valid_date($value['published_at'])) {
        return false;
    }
    foreach (array('manifest_sha256', 'archive_sha256') as $field) {
        if (!is_string($value[$field]) || !preg_match('/^[a-f0-9]{64}$/D', $value[$field])) {
            return false;
        }
    }
    if (!is_int($value['archive_size']) || $value['archive_size'] < 1 || $value['archive_size'] > 268435456 || !is_int($value['file_count']) || $value['file_count'] < 1 || $value['file_count'] > 25000) {
        return false;
    }
    $base = wp_parse_url($base_url);
    if (!is_array($base) || ($base['scheme'] ?? '') !== 'https' || empty($base['host']) || isset($base['user']) || isset($base['pass']) || isset($base['query']) || isset($base['fragment'])) {
        return false;
    }
    $release_url = rtrim($base_url, '/') . '/' . rawurlencode($value['version']) . '/';
    if ($value['manifest_url'] !== $release_url . 'manifest.json' || $value['archive_url'] !== $release_url . 'project.zip') {
        return false;
    }
    // Only the public protocol is exposed, even if deployment metadata has extra keys.
    return array_intersect_key($value, array_flip($fields));
}

function lctp_library_sync_read_release($root, $base_url) {
    $path = rtrim($root, '/') . '/latest.json';
    if (!is_file($path) || is_link($path) || filesize($path) > 16384) {
        return lctp_library_sync_unavailable();
    }
    $raw = @file_get_contents($path);
    $value = $raw === false ? null : json_decode($raw, true);
    $metadata = lctp_library_sync_validate_metadata($value, $base_url);
    if ($metadata === false) {
        return lctp_library_sync_unavailable();
    }
    $release = rtrim($root, '/') . '/releases/' . $metadata['version'];
    $manifest = $release . '/manifest.json';
    $archive = $release . '/project.zip';
    // Publication only becomes visible when both immutable assets are in place.
    if (is_link($release) || is_link($manifest) || is_link($archive) || !is_file($manifest) || !is_file($archive) || filesize($archive) !== $metadata['archive_size']) {
        return lctp_library_sync_unavailable();
    }
    return $metadata;
}

function lctp_library_sync_etag_matches($header, $etag) {
    foreach (explode(',', (string) $header) as $condition) {
        $condition = trim($condition);
        if ($condition === '*' || preg_replace('/^W\//', '', $condition) === $etag) {
            return true;
        }
    }
    return false;
}

function lctp_library_sync_response($request) {
    $metadata = lctp_library_sync_read_release(ABSPATH . 'lctp-library', home_url('/lctp-library/releases/'));
    if (is_wp_error($metadata)) {
        return new WP_REST_Response(array('code' => $metadata->get_error_code(), 'message' => $metadata->get_error_message(), 'data' => array('status' => 503)), 503, array('Cache-Control' => 'no-store'));
    }
    $etag = '"' . hash('sha256', wp_json_encode($metadata)) . '"';
    $headers = array('Cache-Control' => 'no-cache, max-age=0, must-revalidate', 'ETag' => $etag);
    if (lctp_library_sync_etag_matches($request->get_header('if-none-match'), $etag)) {
        return new WP_REST_Response(null, 304, $headers);
    }
    return new WP_REST_Response($metadata, 200, $headers);
}

add_action('rest_api_init', function () {
    register_rest_route('lctp/v1', '/project', array(
        'methods' => 'GET',
        'callback' => 'lctp_library_sync_response',
        'permission_callback' => '__return_true',
    ));
});
