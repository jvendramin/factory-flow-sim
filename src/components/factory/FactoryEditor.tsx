
import { useState, useCallback, useRef, useEffect } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  NodeTypes,
  Node,
  XYPosition,
  useReactFlow,
  ReactFlowInstance,
  ConnectionMode,
  EdgeTypes,
  ConnectionLineType,
  BackgroundVariant,
  useStoreApi,
  NodeDragHandler,
  ReactFlowProvider,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { toast } from '@/components/ui/use-toast';
import EquipmentNode from './nodes/EquipmentNode';
import GroupNode from './nodes/GroupNode';
import ConfigurableEdge from './edges/ConfigurableEdge';
import { Equipment, FlowEdge, PathStep } from '@/types/equipment';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { ArrowRightCircle, FolderPlus } from 'lucide-react';
import LiveStatsPanel from './LiveStatsPanel';
import { Button } from '@/components/ui/button';

const NODE_WIDTH = 240;
const NODE_HEIGHT = 180;

const nodeTypes: NodeTypes = {
  equipment: EquipmentNode,
  group: GroupNode,
};

const edgeTypes: EdgeTypes = {
  default: ConfigurableEdge,
};

interface FactoryEditorProps {
  isSimulating: boolean;
  simulationMode?: "instant" | "play-by-play";
  simulationSpeed?: number;
  onUnitPositionUpdate?: (position: { nodeId: string, progress: number } | null) => void;
}

const FactoryEditorContent = ({ 
  isSimulating, 
  simulationMode = "instant",
  simulationSpeed = 1,
  onUnitPositionUpdate
}: FactoryEditorProps) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [placeholderNode, setPlaceholderNode] = useState<Node | null>(null);
  const [showConnectionAlert, setShowConnectionAlert] = useState(false);
  const [pendingConnection, setPendingConnection] = useState<Connection | null>(null);
  const [currentUnitPosition, setCurrentUnitPosition] = useState<{ nodeId: string, progress: number } | null>(null);
  const [showGrid, setShowGrid] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const lastTimestamp = useRef<number>(0);
  const activeEdgeRef = useRef<string | null>(null);
  const store = useStoreApi();
  const { getNodes, getEdges, project, screenToFlowPosition } = useReactFlow();
  
  useEffect(() => {
    if (isSimulating && simulationMode === "play-by-play") {
      startPlayByPlaySimulation();
    } else if (!isSimulating && animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
      setCurrentUnitPosition(null);
      if (onUnitPositionUpdate) onUnitPositionUpdate(null);
      
      setNodes(nds => 
        nds.map(node => ({
          ...node,
          data: {
            ...node.data,
            active: false,
            utilization: undefined,
            progress: undefined
          }
        }))
      );
      
      setEdges(eds => 
        eds.map(e => ({
          ...e,
          data: {
            ...e.data,
            transitInProgress: false,
            transitProgress: 0
          }
        }))
      );
    }
    
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
    };
  }, [isSimulating, simulationMode, setNodes, onUnitPositionUpdate, setEdges]);
  
  useEffect(() => {
    const handleEdgeUpdate = (event: CustomEvent) => {
      const { id, data, label } = event.detail;
      
      setEdges(edges => 
        edges.map(e => {
          if (e.id === id) {
            return {
              ...e,
              data,
              label
            };
          }
          return e;
        })
      );
    };
    
    document.addEventListener('edge:update', handleEdgeUpdate as EventListener);
    
    return () => {
      document.removeEventListener('edge:update', handleEdgeUpdate as EventListener);
    };
  }, [setEdges]);
  
  const startPlayByPlaySimulation = useCallback(() => {
    const edgeMap = new Map<string, { targetId: string, transitTime: number }[]>();
    
    edges.forEach(edge => {
      const sources = edgeMap.get(edge.source) || [];
      sources.push({ 
        targetId: edge.target, 
        transitTime: edge.data?.transitTime || 0 
      });
      edgeMap.set(edge.source, sources);
    });
    
    const connectedNodes = new Set<string>();
    const groupChildrenMap = new Map<string, string[]>();
    
    nodes.forEach(node => {
      if (node.parentId) {
        const children = groupChildrenMap.get(node.parentId) || [];
        children.push(node.id);
        groupChildrenMap.set(node.parentId, children);
      }
    });
    
    const findConnectedNodes = (nodeId: string) => {
      if (connectedNodes.has(nodeId)) return;
      connectedNodes.add(nodeId);
      
      if (groupChildrenMap.has(nodeId)) {
        groupChildrenMap.get(nodeId)?.forEach(childId => {
          connectedNodes.add(childId);
        });
      }
      
      const outgoingEdges = edgeMap.get(nodeId) || [];
      outgoingEdges.forEach(edge => {
        findConnectedNodes(edge.targetId);
      });
    };
    
    const allTargets = new Set(edges.map(e => e.target));
    
    const startNodeIds = nodes.filter(n => 
      !allTargets.has(n.id) && 
      edgeMap.has(n.id) && 
      edgeMap.get(n.id)!.length > 0
    ).map(n => n.id);
    
    if (startNodeIds.length === 0) {
      toast({
        title: "Simulation Error",
        description: "Could not identify the starting point of your process flow. Ensure nodes are connected.",
        variant: "destructive"
      });
      return;
    }
    
    startNodeIds.forEach(nodeId => {
      findConnectedNodes(nodeId);
    });
    
    const activePaths: {
      nodeId: string,
      progress: number,
      inTransit: boolean,
      transitTo: string,
      transitTime: number,
      transitProgress: number,
      isGroup?: boolean,
      groupChildren?: string[]
    }[] = startNodeIds.map(id => ({ 
      nodeId: id, 
      progress: 0, 
      inTransit: false,
      transitTo: '', 
      transitTime: 0,
      transitProgress: 0,
      isGroup: nodes.find(n => n.id === id)?.type === 'group',
      groupChildren: groupChildrenMap.get(id)
    }));
    
    const nodeDataMap = new Map(nodes.map(n => [n.id, n.data]));
    
    lastTimestamp.current = 0;
    
    const animate = (timestamp: number) => {
      if (lastTimestamp.current === 0) {
        lastTimestamp.current = timestamp;
        animationFrameRef.current = requestAnimationFrame(animate);
        return;
      }
      
      const delta = (timestamp - lastTimestamp.current) / 1000;
      lastTimestamp.current = timestamp;
      
      if (activePaths.length === 0) {
        toast({
          title: "Simulation Complete",
          description: "All units have completed the process flow."
        });
        
        const nodeUtilizations = new Map<string, number>();
        const nodeCycles = new Map<string, number>();
        
        let bottleneckId = startNodeIds[0];
        let maxCycleTime = 0;
        
        nodes.forEach(node => {
          if (!connectedNodes.has(node.id)) return;
          
          const nodeData = nodeDataMap.get(node.id);
          if (!nodeData) return;
          
          const cycleTime = nodeData.cycleTime || 0;
          const maxCapacity = nodeData.maxCapacity || 1;
          const adjustedCycleTime = maxCapacity > 1 ? cycleTime / maxCapacity : cycleTime;
          
          if (adjustedCycleTime > maxCycleTime) {
            maxCycleTime = adjustedCycleTime;
            bottleneckId = node.id;
          }
          
          const utilization = Math.min(100, Math.round((adjustedCycleTime / maxCycleTime) * 100));
          nodeUtilizations.set(node.id, utilization);
        });
        
        setNodes(nds => 
          nds.map(node => {
            if (!connectedNodes.has(node.id)) {
              return {
                ...node,
                data: {
                  ...node.data,
                  active: false,
                  utilization: 0,
                  bottleneck: false
                }
              };
            }
            
            return {
              ...node,
              data: {
                ...node.data,
                active: false,
                utilization: nodeUtilizations.get(node.id) || 0,
                bottleneck: node.id === bottleneckId
              }
            };
          })
        );
        
        return;
      }
      
      const nextActivePaths: typeof activePaths = [];
      const activeNodeIds = new Set<string>();
      const transitEdges = new Map<string, number>();
      
      activePaths.forEach(path => {
        if (path.inTransit) {
          path.transitProgress += delta * simulationSpeed / path.transitTime;
          
          if (path.transitTime > 0) {
            const edgeId = edges.find(
              e => e.source === path.nodeId && e.target === path.transitTo
            )?.id;
            
            if (edgeId) {
              transitEdges.set(edgeId, path.transitProgress);
            }
          }
          
          if (path.transitProgress >= 1 || path.transitTime <= 0) {
            nextActivePaths.push({
              nodeId: path.transitTo,
              progress: 0,
              inTransit: false,
              transitTo: '',
              transitTime: 0,
              transitProgress: 0
            });
            
            activeNodeIds.add(path.transitTo);
          } else {
            nextActivePaths.push({...path});
          }
        } else {
          const nodeData = nodeDataMap.get(path.nodeId);
          if (!nodeData) return;
          
          activeNodeIds.add(path.nodeId);
          
          if (path.isGroup && path.groupChildren) {
            // For groups, process all children concurrently
            path.groupChildren.forEach(childId => {
              activeNodeIds.add(childId);
            });
            
            // Use the fastest cycle time for the group (concurrent processing)
            let minCycleTime = Infinity;
            path.groupChildren.forEach(childId => {
              const childData = nodeDataMap.get(childId);
              if (childData) {
                const childCycleTime = (childData.cycleTime || 0) / (childData.maxCapacity || 1);
                minCycleTime = Math.min(minCycleTime, childCycleTime);
              }
            });
            
            // If there are no valid cycle times, default to a reasonable value
            const cycleDuration = minCycleTime === Infinity ? 1 : minCycleTime;
            
            path.progress += delta * simulationSpeed / cycleDuration;
          } else {
            // Normal node processing
            let cycleDuration = nodeData.cycleTime || 0;
            let maxCapacity = nodeData.maxCapacity || 1;
            const adjustedCycleDuration = cycleDuration / maxCapacity;
            
            path.progress += delta * simulationSpeed / adjustedCycleDuration;
          }
          
          if (path.progress >= 1) {
            const nextNodes = edgeMap.get(path.nodeId) || [];
            
            if (nextNodes.length === 0) {
              // End of the flow
            } else {
              nextNodes.forEach(({ targetId, transitTime }) => {
                nextActivePaths.push({
                  nodeId: path.nodeId,
                  progress: 1,
                  inTransit: true,
                  transitTo: targetId,
                  transitTime: transitTime,
                  transitProgress: 0,
                  isGroup: nodes.find(n => n.id === targetId)?.type === 'group',
                  groupChildren: groupChildrenMap.get(targetId)
                });
              });
            }
          } else {
            nextActivePaths.push({...path});
          }
        }
      });
      
      activePaths.length = 0;
      activePaths.push(...nextActivePaths);
      
      setNodes(nds => 
        nds.map(node => ({
          ...node,
          data: {
            ...node.data,
            active: activeNodeIds.has(node.id),
            progress: nextActivePaths.find(p => p.nodeId === node.id && !p.inTransit)?.progress
          }
        }))
      );
      
      setEdges(eds => 
        eds.map(e => ({
          ...e,
          data: {
            ...e.data,
            transitInProgress: transitEdges.has(e.id),
            transitProgress: transitEdges.get(e.id) || 0
          }
        }))
      );
      
      const primaryPath = nextActivePaths[0];
      if (primaryPath && !primaryPath.inTransit) {
        setCurrentUnitPosition({ 
          nodeId: primaryPath.nodeId, 
          progress: primaryPath.progress 
        });
        
        if (onUnitPositionUpdate) {
          onUnitPositionUpdate({ 
            nodeId: primaryPath.nodeId, 
            progress: primaryPath.progress 
          });
        }
      } else if (onUnitPositionUpdate) {
        onUnitPositionUpdate(null);
      }
      
      animationFrameRef.current = requestAnimationFrame(animate);
    };
    
    animationFrameRef.current = requestAnimationFrame(animate);
  }, [edges, nodes, setNodes, simulationSpeed, onUnitPositionUpdate, setEdges]);
  
  const onInit = useCallback((instance: ReactFlowInstance) => {
    setReactFlowInstance(instance);
  }, []);
  
  const onConnect = useCallback((params: Connection) => {
    setEdges((eds) => 
      addEdge({ 
        ...params, 
        data: { transitTime: 0 } 
      }, eds)
    );
  }, [setEdges]);

  const handleNodesChange = useCallback((changes) => {
    onNodesChange(changes);
  }, [onNodesChange]);

  const onEdgeChanges = useCallback((changes) => {
    onEdgesChange(changes);
  }, [onEdgesChange]);

  const onConnectStart = useCallback((event: any, { nodeId }: { nodeId: string }) => {
    if (nodeId) {
      setPendingConnection({ source: nodeId, target: '', sourceHandle: null, targetHandle: null });
    }
  }, []);

  const onConnectEnd = useCallback((event: MouseEvent) => {
    setPendingConnection(null);
  }, []);
  
  // Helper function to check if a node is over a group
  const isNodeOverGroup = useCallback((node: Node, groups: Node[]) => {
    if (!node || !groups.length) return null;
    
    // Center point of the node
    const nodeCenter = {
      x: node.position.x + (NODE_WIDTH / 2),
      y: node.position.y + (NODE_HEIGHT / 2)
    };
    
    // Find the first group the node is over
    for (const group of groups) {
      const width = group.style?.width as number || 300;
      const height = group.style?.height as number || 200;
      
      if (
        nodeCenter.x > group.position.x && 
        nodeCenter.x < group.position.x + width &&
        nodeCenter.y > group.position.y && 
        nodeCenter.y < group.position.y + height
      ) {
        return group;
      }
    }
    
    return null;
  }, []);
  
  // Create an empty group
  const createEmptyGroup = useCallback(() => {
    if (!reactFlowInstance || !reactFlowWrapper.current) {
      return;
    }
    
    const { x, y, zoom } = reactFlowInstance.getViewport();
    const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
    
    const position = reactFlowInstance.screenToFlowPosition({
      x: reactFlowBounds.width / 2,
      y: reactFlowBounds.height / 2,
    });
    
    const defaultWidth = 400;
    const defaultHeight = 300;
    
    const groupNode: Node = {
      id: `group-${Date.now()}`,
      type: 'group',
      position,
      style: { 
        width: defaultWidth, 
        height: defaultHeight
      },
      data: { 
        label: 'Sub-Flow',
        nodes: []
      },
    };
    
    setNodes(nds => [...nds, groupNode]);
    
    toast({
      title: "Sub-Flow Created",
      description: "Empty sub-flow created. Drag nodes inside to group them."
    });
  }, [reactFlowInstance, setNodes]);
  
  // Handle node drag events to highlight potential group drops
  const onNodeDrag: NodeDragHandler = useCallback((event, node) => {
    if (isSimulating) return;
    
    // Only process nodes that aren't already in a group
    if (!node.parentNode) {
      const groups = getNodes().filter(n => n.type === 'group' && n.id !== node.id);
      const targetGroup = isNodeOverGroup(node, groups);
      
      // Highlight potential drop targets
      setNodes(nodes => 
        nodes.map(n => {
          if (targetGroup && n.id === targetGroup.id) {
            return {
              ...n,
              className: 'group-drop-target'
            };
          }
          
          // Remove highlight from other groups
          if (n.type === 'group' && n.className?.includes('group-drop-target')) {
            return {
              ...n,
              className: n.className.replace('group-drop-target', '').trim()
            };
          }
          
          return n;
        })
      );
    }
  }, [isSimulating, isNodeOverGroup, getNodes, setNodes]);
  
  // Handle node drag end to finalize group assignment
  const onNodeDragStop: NodeDragHandler = useCallback((event, node) => {
    if (isSimulating) return;
    
    // Only process nodes that aren't already in a group
    if (!node.parentNode) {
      const groups = getNodes().filter(n => n.type === 'group' && n.id !== node.id);
      const targetGroup = isNodeOverGroup(node, groups);
      
      if (targetGroup) {
        // Calculate position relative to group
        const relativePosition = {
          x: node.position.x - targetGroup.position.x,
          y: node.position.y - targetGroup.position.y
        };
        
        // Update node to be child of group
        setNodes(nodes => {
          return nodes.map(n => {
            if (n.id === node.id) {
              return {
                ...n,
                position: relativePosition,
                parentNode: targetGroup.id,
                extent: 'parent' as const,
                className: ''
              };
            } else if (n.id === targetGroup.id) {
              return {
                ...n,
                data: {
                  ...n.data,
                  nodes: [...(n.data.nodes || []), node.id]
                },
                className: (n.className || '').replace('group-drop-target', '').trim()
              };
            }
            return {
              ...n,
              className: (n.className || '').replace('group-drop-target', '').trim()
            };
          });
        });
        
        toast({
          title: "Node Added to Sub-Flow",
          description: "Node has been added to the sub-flow"
        });
      } else {
        // Clear any highlight classes
        setNodes(nodes => 
          nodes.map(n => ({
            ...n,
            className: (n.className || '').replace('group-drop-target', '').trim()
          }))
        );
      }
    }
  }, [isSimulating, isNodeOverGroup, getNodes, setNodes]);
  
  // Handle dropping new equipment onto the canvas
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setPlaceholderNode(null);

      if (!reactFlowInstance || !reactFlowWrapper.current) {
        return;
      }

      // Parse the dragged equipment data
      const equipmentData = JSON.parse(event.dataTransfer.getData('application/reactflow'));
      
      if (typeof equipmentData.type !== 'string') {
        return;
      }

      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });

      // Check if dropping inside a group
      const groups = getNodes().filter(n => n.type === 'group');
      
      // Find which group (if any) the position is inside of
      let parentGroup = null;
      for (const group of groups) {
        const width = group.style?.width as number || 300;
        const height = group.style?.height as number || 200;
        
        if (
          position.x > group.position.x && 
          position.x < group.position.x + width &&
          position.y > group.position.y && 
          position.y < group.position.y + height
        ) {
          parentGroup = group;
          break;
        }
      }
      
      // Set position based on whether we're dropping in a group
      let newNodePosition = position;
      let parentNodeId = undefined;
      
      if (parentGroup) {
        // Calculate position relative to the group
        newNodePosition = {
          x: position.x - parentGroup.position.x,
          y: position.y - parentGroup.position.y
        };
        parentNodeId = parentGroup.id;
      }

      // Create the new node
      const newNode = {
        id: `equipment-${Date.now()}`,
        type: 'equipment',
        position: newNodePosition,
        parentNode: parentNodeId,
        extent: parentNodeId ? 'parent' as const : undefined,
        data: { 
          ...equipmentData,
          maxCapacity: equipmentData.maxCapacity || 1 
        },
      };

      // Add the node to the canvas
      setNodes((nds) => nds.concat(newNode));
      
      // If adding to a group, update the group data
      if (parentGroup) {
        setNodes(nds => 
          nds.map(n => {
            if (n.id === parentGroup.id) {
              return {
                ...n,
                data: {
                  ...n.data,
                  nodes: [...(n.data.nodes || []), newNode.id]
                }
              };
            }
            return n;
          })
        );
      }

      toast({
        title: `Added ${equipmentData.name}`,
        description: `${equipmentData.name} has been added to the factory floor`,
      });
    },
    [reactFlowInstance, setNodes, getNodes]
  );

  // Handle drag over events for live preview
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    
    if (!reactFlowInstance || !reactFlowWrapper.current) {
      return;
    }
    
    try {
      const jsonData = event.dataTransfer.getData('application/reactflow');
      if (!jsonData) return;
      
      const equipmentData = JSON.parse(jsonData);
      
      const reactFlowBounds = reactFlowWrapper.current.getBoundingClientRect();
      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX - reactFlowBounds.left,
        y: event.clientY - reactFlowBounds.top,
      });
      
      if (!placeholderNode) {
        const placeholder = {
          id: 'placeholder',
          type: 'equipment',
          position,
          data: { 
            ...equipmentData,
            name: `${equipmentData.name} (Preview)`,
            placeholder: true 
          },
          className: 'opacity-50 border-dashed',
        };
        setPlaceholderNode(placeholder);
        setNodes(nds => [...nds.filter(n => n.id !== 'placeholder'), placeholder]);
      } else {
        setNodes(nds => 
          nds.map(n => {
            if (n.id === 'placeholder') {
              return {
                ...n,
                position,
              };
            }
            return n;
          })
        );
      }
    } catch (err) {
    }
    
  }, [reactFlowInstance, placeholderNode, setNodes]);
  
  // Handle drag leave events
  const onDragLeave = useCallback(() => {
    if (placeholderNode) {
      setNodes(nds => nds.filter(n => n.id !== 'placeholder'));
      setPlaceholderNode(null);
    }
  }, [placeholderNode, setNodes]);
  
  // Find best position for new nodes
  const findBestNodePosition = useCallback(() => {
    let maxX = 0;
    let avgY = 0;
    
    if (nodes.length === 0) {
      return { x: 100, y: 200 };
    }
    
    nodes.forEach(node => {
      if (node.position.x > maxX) {
        maxX = node.position.x;
      }
      avgY += node.position.y;
    });
    
    avgY = avgY / nodes.length;
    
    return { x: maxX + 250, y: avgY };
  }, [nodes]);
  
  // Handle adding nodes from connection
  const handleAddFromConnection = useCallback((equipment: Equipment) => {
    if (!pendingConnection || !pendingConnection.source) return;
    
    const position = findBestNodePosition();
    
    const newNode = {
      id: `equipment-${Date.now()}`,
      type: 'equipment',
      position,
      data: { 
        ...equipment,
        maxCapacity: equipment.maxCapacity || 1  
      },
    };
    
    setNodes((nds) => nds.concat(newNode));
    
    const connection = {
      ...pendingConnection,
      target: newNode.id,
      data: { transitTime: 0 }
    };
    
    setEdges((eds) => addEdge(connection, eds));
    
    toast({
      title: `Added ${equipment.name}`,
      description: `${equipment.name} has been connected to the previous node`,
    });
    
    setPendingConnection(null);
    setShowConnectionAlert(false);
  }, [pendingConnection, findBestNodePosition, setNodes, setEdges]);
  
  // Snap nodes to grid on drag stop
  const onNodeDragStopGrid = useCallback((event: any, node: Node) => {
    if (!snapToGrid) return;
    
    const newNodes = nodes.map(n => {
      if (n.id === node.id) {
        return {
          ...n,
          position: {
            x: Math.round(n.position.x / 20) * 20,
            y: Math.round(n.position.y / 20) * 20
          }
        };
      }
      return n;
    });
    
    setNodes(newNodes);
  }, [nodes, setNodes, snapToGrid]);
  
  // Handle node deletion
  const onNodesDelete = useCallback((nodesToDelete: Node[]) => {
    const nodeIds = nodesToDelete.map(n => n.id);
    
    // For any groups being deleted, release their children first
    const groupsToDelete = nodesToDelete.filter(n => n.type === 'group');
    
    if (groupsToDelete.length > 0) {
      setNodes(nodes => {
        let updatedNodes = [...nodes];
        
        // First, adjust positions for all children of deleted groups
        groupsToDelete.forEach(group => {
          updatedNodes = updatedNodes.map(node => {
            if (node.parentNode === group.id) {
              return {
                ...node,
                position: {
                  x: group.position.x + node.position.x,
                  y: group.position.y + node.position.y,
                },
                parentNode: undefined,
                extent: undefined
              };
            }
            return node;
          });
        });
        
        // Then filter out the deleted nodes
        return updatedNodes.filter(n => !nodeIds.includes(n.id));
      });
    } else {
      // Regular deletion for non-group nodes
      setNodes(nodes => nodes.filter(n => !nodeIds.includes(n.id)));
    }
    
    // Remove associated edges
    setEdges(eds => eds.filter(e => !nodeIds.includes(e.source) && !nodeIds.includes(e.target)));
    
    toast({
      title: "Equipment Removed",
      description: "The selected equipment has been removed from the factory floor",
    });
  }, [setNodes, setEdges]);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="px-4 pt-2 flex justify-between items-center">
        <LiveStatsPanel nodes={nodes} edges={edges} />
      </div>
      <div className="flex-1" ref={reactFlowWrapper}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={handleNodesChange}
          onEdgesChange={onEdgeChanges}
          onNodesDelete={onNodesDelete}
          onConnect={onConnect}
          onConnectStart={onConnectStart}
          onConnectEnd={onConnectEnd}
          onInit={onInit}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onNodeDragStop={onNodeDragStopGrid}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={{
            type: 'default'
          }}
          connectionLineType={ConnectionLineType.SmoothStep}
          fitView
          connectionMode={ConnectionMode.Loose}
          attributionPosition="bottom-right"
          className="bg-muted/20"
          snapToGrid={snapToGrid}
          snapGrid={[20, 20]}
          defaultViewport={{ x: 0, y: 0, zoom: 1 }}
          deleteKeyCode={['Backspace', 'Delete']}
        >
          <Background 
            variant={BackgroundVariant.Dots}
            gap={20} 
            size={1} 
            color={showGrid ? 'currentColor' : 'transparent'} 
            className="opacity-30"
          />
          <Controls />
          <MiniMap 
            nodeColor={(node) => {
              if (isSimulating && node.data?.bottleneck) return '#ef4444';
              if (node.type === 'group') return '#94a3b8';
              return '#1D4ED8';
            }}
          />
          
          <div 
            className="sub-flow-button"
            onClick={createEmptyGroup}
          >
            <FolderPlus size={16} />
            Create Sub-Flow
          </div>
        </ReactFlow>
      </div>
      
      <AlertDialog open={showConnectionAlert} onOpenChange={setShowConnectionAlert}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add Connected Equipment</AlertDialogTitle>
            <AlertDialogDescription>
              Would you like to add a new piece of equipment and connect it to the source?
              Choose the equipment you want to add from the sidebar.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingConnection(null)}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              toast({
                title: "Select from sidebar",
                description: "Drag an equipment item from the sidebar to connect it",
                action: (
                  <div className="flex items-center">
                    <ArrowRightCircle className="h-4 w-4 mr-2" />
                    <span>Drag from sidebar</span>
                  </div>
                ),
              });
              setShowConnectionAlert(false);
            }}>
              Choose Equipment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

const FactoryEditor = (props: FactoryEditorProps) => {
  return (
    <ReactFlowProvider>
      <FactoryEditorContent {...props} />
    </ReactFlowProvider>
  );
};

export default FactoryEditor;
