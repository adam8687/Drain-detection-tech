import {validateMeasurement,calibrationSnapshot} from './records-domain.js';

// Historical conversion selects the wired/default A channel explicitly. The
// untouched original must be archived by the caller before this result is saved.
export function convertTwoSensorRecord(record) {
  const calibration=record.calibration===null?null:calibrationSnapshot({empty_distance_mm:record.calibration.empty_distance_mm??record.calibration.sensor_a_empty_mm});
  const measurements=record.measurements.map(point=>validateMeasurement(point.sensor
    ? point
    : {reading_id:point.reading_id,timestamp:point.timestamp,sensor:point.sensor_a}));
  const interrupted=record.recording_status==='recording';
  return {...record,schema_version:1,calibration,measurements,recording_status:interrupted?'finished':record.recording_status,
    result:interrupted&&record.record_type==='drainage'?{drainage_time_seconds:null,outcome:'uncertain'}:record.result};
}
export function publicSensorRecord(record) {
  if(!record)return null;
  const {schema_version,revision,...rest}=record;
  return schema_version===1?{...rest,schema_version:1}:rest;
}
